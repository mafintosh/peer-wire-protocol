var assert = require('assert');
var wireProtocol = require('../index');
var wire = wireProtocol();
var bufferFrom = require('buffer-from');

wire.pipe(wire);

var ran = 0;

wire.on('handshake', function(infoHash, peerId) {
	assert.equal(infoHash.length, 20);
	assert.equal(infoHash.toString(), '01234567890123456789');
	assert.equal(peerId.length, 20);
	assert.equal(peerId.toString(), '12345678901234567890');
	ran++;
});

wire.on('unchoke', function() {
	assert.ok(!wire.peerChoking);
	ran++;
});

wire.on('interested', function() {
	assert.ok(wire.peerInterested);
	ran++;
});

assert.equal(wire.peerRequests.length, 0);
wire.on('request', function(i, offset, length, callback) {
	assert.equal(wire.requests.length, 1);
	assert.equal(i, 0);
	assert.equal(offset, 1);
	assert.equal(length, 11);
	ran++;
	callback(null, bufferFrom('hello world'));
});

wire.handshake(bufferFrom('01234567890123456789'), bufferFrom('12345678901234567890'));

assert.ok(wire.amChoking);
assert.ok(wire.peerChoking);
assert.ok(!wire.amInterested);
assert.ok(!wire.peerInterested);

wire.unchoke();
wire.interested();

assert.ok(!wire.amChoking);
assert.ok(wire.amInterested);

wire.once('unchoke', function() {
	assert.equal(wire.requests.length, 0);
	wire.request(0, 1, 11, function(err, buffer) {
		assert.equal(wire.requests.length, 0);
		assert.ok(!err);
		assert.equal(buffer.toString(), 'hello world');
		clearTimeout(timeout);
		assert.equal(ran, 4);
	});
	assert.equal(wire.requests.length, 1);
});

var timeout = setTimeout(function() {
	assert.ok(false);
}, 1000);