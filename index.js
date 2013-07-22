var Duplex = require('stream').Duplex || require('readable-stream').Duplex;
var EventEmitter = require('events').EventEmitter;
var bitfield = require('bitfield');

var MESSAGE_PROTOCOL     = new Buffer('\x13BitTorrent protocol');
var MESSAGE_KEEP_ALIVE   = new Buffer('\x00\x00\x00\x00');
var MESSAGE_CHOKE        = new Buffer('\x00\x00\x00\x01\x00');
var MESSAGE_UNCHOKE      = new Buffer('\x00\x00\x00\x01\x01');
var MESSAGE_INTERESTED   = new Buffer('\x00\x00\x00\x01\x02');
var MESSAGE_UNINTERESTED = new Buffer('\x00\x00\x00\x01\x03');

var ID_CHOKE        = 0;
var ID_UNCHOKE      = 1;
var ID_INTERESTED   = 2;
var ID_UNINTERESTED = 3;
var ID_HAVE         = 4;
var ID_BITFIELD     = 5;
var ID_REQUEST      = 6;
var ID_PIECE        = 7;
var ID_CANCEL       = 8;
var ID_PORT         = 9;

var noop = function() {};

var pull = function(requests, piece, offset, length) {
	for (var i = 0; i < requests.length; i++) {
		var req = requests[i];
		if (req.piece !== piece || req.offset !== offset || req.length !== length) continue;
		requests.splice(i, 1);
		return req;
	}
	return null;
};

var Request = function(piece, offset, length, callback) {
	this.piece = piece;
	this.offset = offset;
	this.length = length;
	this.callback = callback;
	this.timeout = null;
};

var Wire = function() {
	if (!(this instanceof Wire)) return new Wire();
	Duplex.call(this);
	var self = this;

	this.amChoking = true;
	this.amInterested = false;
	this.peerChoking = true;
	this.peerInterested = false;
	this.peerPieces = [];
	this.peerExtensions = {};
	this.peerAddress = null; // external
	this.peerSpeed = null;   // external

	this.uploaded = 0;
	this.downloaded = 0;

	this.requests = [];
	this.peerRequests = [];

	this._keepAlive = null;
	this._finished = false;

	this.on('finish', function() {
		self._finished = true;
		self.push(null); // cannot be half open
		clearInterval(self._keepAlive);
		self._parse(Number.MAX_VALUE, noop);
		while (self.peerRequests.length) self.peerRequests.pop();
		while (self.requests.length) self._callback(self.requests.shift(), new Error('wire is closed'), null);
	});

	var ontimeout = function() {
		self._callback(self.requests.shift(), new Error('request has timed out'), null);
		self.emit('timeout');
	};

	this._timeout = 0;
	this._ontimeout = ontimeout;

	var onmessagelength = function(buffer) {
		var length = buffer.readUInt32BE(0);
		if (length) return self._parse(length, onmessage);
		self._parse(4, onmessagelength);
		self.emit('keep-alive');
	};

	var onmessage = function(buffer) {
		self._parse(4, onmessagelength);
		switch (buffer[0]) {
			case ID_CHOKE:
			return self._onchoke();
			case ID_UNCHOKE:
			return self._onunchoke();
			case ID_INTERESTED:
			return self._oninterested();
			case ID_UNINTERESTED:
			return self._onuninterested();
			case ID_HAVE:
			return self._onhave(buffer.readUInt32BE(1));
			case ID_BITFIELD:
			return self._onbitfield(buffer.slice(1));
			case ID_REQUEST:
			return self._onrequest(buffer.readUInt32BE(1), buffer.readUInt32BE(5), buffer.readUInt32BE(9));
			case ID_PIECE:
			return self._onpiece(buffer.readUInt32BE(1), buffer.readUInt32BE(5), buffer.slice(9));
			case ID_CANCEL:
			return self._oncancel(buffer.readUInt32BE(1), buffer.readUInt32BE(5), buffer.readUInt32BE(9));
			case ID_PORT:
			return self._onport(buffer.readUInt16BE(1));
		}
		self.emit('unknownmessage', buffer);
	};

	this._buffer = [];
	this._bufferSize = 0;
	this._parser = null;
	this._parserSize = 0;

	this._parse(1, function(buffer) {
		var pstrlen = buffer.readUInt8(0);
		self._parse(pstrlen + 48, function(handshake) {
			handshake = handshake.slice(pstrlen);
			self._onhandshake(handshake.slice(8, 28), handshake.slice(28, 48), {dht: !!(handshake[7] & 1)});
			self._parse(4, onmessagelength);
		});
	});
};

Wire.prototype.__proto__ = Duplex.prototype;

Wire.prototype.handshake = function(infoHash, peerId, extensions) {
	if (typeof infoHash === 'string') infoHash = new Buffer(infoHash, 'hex');
	if (typeof peerId === 'string') peerId = new Buffer(peerId);
	if (infoHash.length !== 20 || peerId.length !== 20) throw new Error('infoHash and peerId MUST have length 20');

	var reserved = new Buffer([0,0,0,0,0,0,0,0]);
	if (extensions && extensions.dht) reserved[7] |= 1;

	this._push(Buffer.concat([MESSAGE_PROTOCOL, reserved, infoHash, peerId], MESSAGE_PROTOCOL.length+48));
};

Wire.prototype.choke = function() {
	if (this.amChoking) return;
	this.amChoking = true;
	while (self.peerRequests.length) self.peerRequests.pop();
	this._push(MESSAGE_CHOKE);
};

Wire.prototype.unchoke = function() {
	if (!this.amChoking) return;
	this.amChoking = false;
	this._push(MESSAGE_UNCHOKE);
};

Wire.prototype.interested = function() {
	if (this.amInterested) return;
	this.amInterested = true;
	this._push(MESSAGE_INTERESTED);
};

Wire.prototype.uninterested = function() {
	if (!this.amInterested) return;
	this.amInterested = false;
	this._push(MESSAGE_UNINTERESTED);
};

Wire.prototype.bitfield = function(bitfield) {
	if (bitfield.buffer) bitfield = bitfield.buffer; // support bitfield objects
	this._message(ID_BITFIELD, [], bitfield);
};

Wire.prototype.have = function(i) {
	this._message(ID_HAVE, [i]);
};

Wire.prototype.setKeepAlive = function(bool) {
	clearInterval(this._keepAlive);
	if (bool === false) return;
	this._keepAlive = setInterval(this.push.bind(this, MESSAGE_KEEP_ALIVE), 60000);
};

Wire.prototype.setTimeout = function(ms, fn) {
	if (this.requests.length) clearTimeout(this.requests[0].timeout);
	this._timeout = ms;
	this._updateTimeout();
	if (fn) this.on('timeout', fn);
};

Wire.prototype.request = function(i, offset, length, callback) {
	if (!callback) callback = noop;
	if (this._finished) return callback(new Error('wire is closed'));
	if (this.peerChoking) return callback(new Error('peer is choking'));
	this.requests.push(new Request(i, offset, length, callback));
	this._updateTimeout();
	this._message(ID_REQUEST, [i, offset, length]);
};

Wire.prototype.cancel = function(i, offset, length) {
	this._callback(pull(this.requests, i, offset, length), new Error('request was cancelled'), null);
	this._message(ID_CANCEL, [i, offset, length]);
};

Wire.prototype.piece = function(i, offset, buffer) {
	this.uploaded += buffer.length;
	this.emit('upload', buffer.length);
	this._message(ID_PIECE, [i, offset], buffer);
};

Wire.prototype.port = function(port) {
	var message = new Buffer([0,0,0,3,9,0,0]);
	message.writeUInt16BE(port, 5);
	this._push(message);
};

Wire.prototype.destroy = function() {
	this.emit('close');
	this.end();
};

// inbound

Wire.prototype._onhandshake = function(infoHash, peerId, extensions) {
	this.peerExtensions = extensions;
	this.emit('handshake', infoHash, peerId, extensions);
};

Wire.prototype._oninterested = function() {
	this.peerInterested = true;
	this.emit('interested');
};

Wire.prototype._onuninterested = function() {
	this.peerInterested = false;
	this.emit('uninterested');
};

Wire.prototype._onchoke = function() {
	this.peerChoking = true;
	this.emit('choke');
	while (this.requests.length) this._callback(this.requests.shift(), new Error('peer is choking'), null);
};

Wire.prototype._onunchoke = function() {
	this.peerChoking = false;
	this.emit('unchoke');
};

Wire.prototype._onbitfield = function(buffer) {
	var pieces = bitfield(buffer);
	for (var i = 0; i < 8 * buffer.length; i++) {
		this.peerPieces[i] = pieces.get(i);
	}
	this.emit('bitfield', buffer);
};

Wire.prototype._onhave = function(i) {
	this.peerPieces[i] = true;
	this.emit('have', i);
};

Wire.prototype._onrequest = function(i, offset, length) {
	if (this.amChoking) return;

	var self = this;
	var request = new Request(i, offset, length, respond);
	var respond = function(err, buffer) {
		if (err || request !== pull(self.peerRequests, i, offset, length)) return;
		self.piece(i, offset, buffer);
	};

	this.peerRequests.push(request);
	this.emit('request', i, offset, length, respond);
};

Wire.prototype._oncancel = function(i, offset, length) {
	pull(this.peerRequests, i, offset, length);
	this.emit('cancel', i, offset, length);
};

Wire.prototype._onpiece = function(i, offset, buffer) {
	this._callback(pull(this.requests, i, offset, buffer.length), null, buffer);
	this.downloaded += buffer.length;
	this.emit('download', buffer.length);
	this.emit('piece', i, offset, buffer);
};

Wire.prototype._onport = function(port) {
	this.emit('port', port);
};

// helpers and streams

Wire.prototype._callback = function(request, err, buffer) {
	if (!request) return;
	if (request.timeout) clearTimeout(request.timeout);
	if (!this.peerChoking && !this._finished) this._updateTimeout();
	request.callback(err, buffer);
};

Wire.prototype._updateTimeout = function() {
	if (!this._timeout || !this.requests.length || this.requests[0].timeout) return;
	this.requests[0].timeout = setTimeout(this._ontimeout, this._timeout);
};

Wire.prototype._message = function(id, numbers, data) {
	var dataLength = data ? data.length : 0;
	var buffer = new Buffer(5 + 4 * numbers.length);

	buffer.writeUInt32BE(buffer.length + dataLength - 4, 0);
	buffer[4] = id;
	numbers.forEach(function(num, i) {
		buffer.writeUInt32BE(num, 5 + 4 * i);
	});

	this._push(buffer);
	if (data) this._push(data);
};

Wire.prototype._push = function(data) {
	if (this._finished) return;
	this.push(data);
};

Wire.prototype._parse = function(size, parser) {
	this._parserSize = size;
	this._parser = parser;
};

Wire.prototype._write = function(data, encoding, callback) {
	this._bufferSize += data.length;
	this._buffer.push(data);

	while (this._bufferSize >= this._parserSize) {
		var buffer = this._buffer.length === 1 ? this._buffer[0] : Buffer.concat(this._buffer, this._bufferSize);
		this._bufferSize -= this._parserSize;
		this._buffer = this._bufferSize ? [buffer.slice(this._parserSize)] : [];
		this._parser(buffer.slice(0, this._parserSize));
	}

	callback();
};

Wire.prototype._read = noop;

module.exports = Wire;