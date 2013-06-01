// Worker HTTP
// ===========

(function() {
	// override dispatch() behavior to post it to the host document
	// - `conn`: optional PageConnection, to specify the target page of the request
	// - `conn` defaults to the host page
	local.web.dispatch = function(request, conn) {
		if (!request) { throw "no request param provided to request"; }
		if (typeof request == 'string')
			request = { url: request };
		if (!request.url)
			throw "no url on request";
		if (!conn)
			conn = local.worker.hostConnection;

		// if not given a local.web.Request, make one and remember to end the request ourselves
		var body = null, selfEnd = false;
		if (!(request instanceof local.web.Request)) {
			body = request.body;
			request = new local.web.Request(request);
			selfEnd = true; // we're going to end()
		}

		// setup exchange and exchange handlers
		var response_ = local.promise();
		var exchange = conn.startExchange('web_request');
		conn.setExchangeMeta(exchange, 'request', request);
		conn.setExchangeMeta(exchange, 'response_', response_);
		conn.onMessage(exchange, 'response_headers', onWebResponseHeaders.bind(conn));
		conn.onMessage(exchange, 'response_data', onWebResponseData.bind(conn));
		conn.onMessage(exchange, 'response_end', onWebResponseEnd.bind(conn));
		conn.onMessage(exchange, 'close', onWebClose.bind(conn));

		// wire request into the exchange
		conn.sendMessage(exchange, 'request_headers', request);
		request.on('data', function(data) { conn.sendMessage(exchange, 'request_data', data); });
		request.on('end', function() { conn.sendMessage(exchange, 'request_end'); });
		if (selfEnd) request.end(body);

		return response_;
	};

	// EXPORTED
	// adds the web_request exchange protocol to the page connection
	function startWebExchange(pageConn) {
		pageConn.onExchange('web_request', onWebRequestExchange.bind(pageConn));
	}
	local.worker.startWebExchange = startWebExchange;

	// INTERNAL
	// handles incoming requests from the page
	function onWebRequestExchange(exchange) {
		this.onMessage(exchange, 'request_headers', onWebRequestHeaders.bind(this));
		this.onMessage(exchange, 'request_data', onWebRequestData.bind(this));
		this.onMessage(exchange, 'request_end', onWebRequestEnd.bind(this));
		this.onMessage(exchange, 'close', onWebClose.bind(this));
	}

	function onWebRequestHeaders(message) {
		if (!message.data) {
			console.error('Invalid "request_headers" message from page: Payload missing', message);
			this.endExchange(message.exchange);
			return;
		}

		var self = this;
		if (main) {
			// create request & response
			var request = new local.web.Request(message.data);
			var response = new local.web.Response();
			this.setExchangeMeta(message.exchange, 'request', request);
			this.setExchangeMeta(message.exchange, 'response', response);

			// wire response into the exchange
			response.on('headers', function() { self.sendMessage(message.exchange, 'response_headers', response); });
			response.on('data', function(data) { self.sendMessage(message.exchange, 'response_data', data); });
			response.on('end', function() { self.sendMessage(message.exchange, 'response_end'); });
			response.on('close', function() { self.endExchange(message.exchange); });

			// pass on to the request handler
			main(request, response);
		} else {
			this.sendMessage(message.exchange, 'response_headers', { status: 500, reason: 'server not loaded' });
			this.sendMessage(message.exchange, 'response_end');
			this.endExchange(message.exchange);
		}
	}

	function onWebRequestData(message) {
		if (!message.data || typeof message.data != 'string') {
			console.error('Invalid "request_data" message from worker: Payload must be a string', message);
			this.endExchange(message.exchange);
			return;
		}

		var request = this.getExchangeMeta(message.exchange, 'request');
		if (!request) {
			console.error('Invalid "request_data" message from worker: Request headers not previously received', message);
			this.endExchange(message.exchange);
			return;
		}

		request.write(message.data);
	}

	function onWebRequestEnd(message) {
		var request = this.getExchangeMeta(message.exchange, 'request');
		if (!request) {
			console.error('Invalid "request_end" message from worker: Request headers not previously received', message);
			this.endExchange(message.exchange);
			return;
		}

		request.end();
	}

	function onWebResponseHeaders(message) {
		if (!message.data) {
			console.error('Invalid "response_headers" message from worker: Payload missing', message);
			this.endExchange(message.exchange);
			return;
		}

		var response_ = this.getExchangeMeta(message.exchange, 'response_');
		if (!response_) {
			console.error('Internal error when receiving "response_headers" message from worker: Response promise not present', message);
			this.endExchange(message.exchange);
			return;
		}

		var response = new local.web.Response();
		response.writeHead(message.data.status, message.data.reason, message.data.headers);
		this.setExchangeMeta(message.exchange, 'response', response);
		local.web.fulfillResponsePromise(response_, response);
	}

	function onWebResponseData(message) {
		if (!message.data || typeof message.data != 'string') {
			console.error('Invalid "response_data" message from worker: Payload must be a string', message);
			this.endExchange(message.exchange);
			return;
		}

		var response = this.getExchangeMeta(message.exchange, 'response');
		if (!response) {
			console.error('Internal error when receiving "response_data" message from worker: Response object not present', message);
			this.endExchange(message.exchange);
			return;
		}

		response.write(message.data);
	}

	function onWebResponseEnd(message) {
		var response = this.getExchangeMeta(message.exchange, 'response');
		if (!response) {
			console.error('Internal error when receiving "response_end" message from worker: Response object not present', message);
			this.endExchange(message.exchange);
			return;
		}

		response.end();
	}

	// closes the request/response, caused by a close of the exchange
	// - could happen because the response has ended
	// - could also happen because the request aborted
	// - could also happen due to a bad message
	function onWebClose(message) {
		var request = this.getExchangeMeta(message.exchange, 'request');
		var response = this.getExchangeMeta(message.exchange, 'response');
		if (request) request.close();
		if (response) response.close();
	}
})();

// override subscribe() behavior to post it to the host document
// local.web.setEventSubscriber(function(request) {
// 	var eventStream = new local.web.EventStream();

// 	// have the environment create the subscription
// 	var msgStream = local.worker.postNamedMessage('httpSubscribe', request);

// 	// change event listening to pass the request to the environment
// 	eventStream.addListener = eventStream.on = function(e, listener) {
// 		local.worker.postNamedMessage(msgStream, e, function(reply) {
// 			// setup the stream as an event-pipe
// 			local.worker.onNamedMessage(reply.id, function(eventMessage) {
// 				listener(eventMessage.data);
// 			});
// 		});
// 	};

// 	// on close, signal the stream close to parent
// 	eventStream.on('close', function() {
// 		local.worker.endMessage(msgStream);
// 	});

// 	return eventStream;
// });