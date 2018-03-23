var assert = require('assert');
var wireProtocol = require('../index');
var wire = wireProtocol();
var bufferFrom = require('buffer-from');

var timeouts = 0;

wire.pipe(wire);
wire.setTimeout(1000);

wire.handshake(bufferFrom('01234567890123456789'), bufferFrom('12345678901234567890'));
wire.unchoke();

wire.on('request', function(i, offset, length, callback) {
	callback(null, bufferFrom('hello world'));
});

wire.on('unchoke', function() {
	var requests = 0;

	wire.request(0, 0, 11, function(err) {
		assert.ok(!err);
		assert.ok(++requests === 1);
	});

	wire.request(0, 0, 11, function(err) {
		assert.ok(!err);
		assert.ok(++requests === 2);
	});

	wire.request(0, 0, 11, function(err) {
		assert.ok(!err);
		assert.ok(++requests === 3);
		clearTimeout(timeout);
	});
});

wire.on('timeout', function() {
	assert.ok(false);
});

var timeout = setTimeout(function() {
	process.exit(1);
}, 5000);