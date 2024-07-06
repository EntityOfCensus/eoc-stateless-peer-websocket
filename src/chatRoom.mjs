// =======================================================================================
// The ChatRoom Durable Object Class

// ChatRoom implements a Durable Object that coordinates an individual chat room. Participants
// connect to the room using WebSockets, and the room broadcasts messages from each participant
// to all others.
export class ChatRoom {
	constructor(state, env) {
	  this.state = state

	  // `state.storage` provides access to our durable storage. It provides a simple KV
	  // get()/put() interface.
	  this.storage = state.storage;

	  // `env` is our environment bindings (discussed earlier).
	  this.env = env;

	  // We will track metadata for each client WebSocket object in `sessions`.
	  this.sessions = new Map();
	  this.state.getWebSockets().forEach((webSocket) => {
		// The constructor may have been called when waking up from hibernation,
		// so get previously serialized metadata for any existing WebSockets.
		let meta = webSocket.deserializeAttachment();

		// Set up our rate limiter client.
		// The client itself can't have been in the attachment, because structured clone doesn't work on functions.
		// DO ids aren't cloneable, restore the ID from its hex string
		let limiterId = this.env.limiters.idFromString(meta.limiterId);
		let limiter = new RateLimiterClient(
		  () => this.env.limiters.get(limiterId),
		  err => webSocket.close(1011, err.stack));

		// We don't send any messages to the client until it has sent us the initial user info
		// message. Until then, we will queue messages in `session.blockedMessages`.
		// This could have been arbitrarily large, so we won't put it in the attachment.
		let blockedMessages = [];
		this.sessions.set(webSocket, { ...meta, limiter, blockedMessages });
	  });

	  // We keep track of the last-seen message's timestamp just so that we can assign monotonically
	  // increasing timestamps even if multiple messages arrive simultaneously (see below). There's
	  // no need to store this to disk since we assume if the object is destroyed and recreated, much
	  // more than a millisecond will have gone by.
	  this.lastTimestamp = 0;
	}

	// The system will call fetch() whenever an HTTP request is sent to this Object. Such requests
	// can only be sent from other Worker code, such as the code above; these requests don't come
	// directly from the internet. In the future, we will support other formats than HTTP for these
	// communications, but we started with HTTP for its familiarity.
	async fetch(request) {
	  return await handleErrors(request, async () => {
		let url = new URL(request.url);

		switch (url.pathname) {
		  case "/websocket": {
			// The request is to `/api/room/<name>/websocket`. A client is trying to establish a new
			// WebSocket session.
			if (request.headers.get("Upgrade") != "websocket") {
			  return new Response("expected websocket", {status: 400});
			}

			// Get the client's IP address for use with the rate limiter.
			let ip = request.headers.get("CF-Connecting-IP");

			// To accept the WebSocket request, we create a WebSocketPair (which is like a socketpair,
			// i.e. two WebSockets that talk to each other), we return one end of the pair in the
			// response, and we operate on the other end. Note that this API is not part of the
			// Fetch API standard; unfortunately, the Fetch API / Service Workers specs do not define
			// any way to act as a WebSocket server today.
			let pair = new WebSocketPair();

			// We're going to take pair[1] as our end, and return pair[0] to the client.
			await this.handleSession(pair[1], ip);

			// Now we return the other end of the pair to the client.
			return new Response(null, { status: 101, webSocket: pair[0] });
		  }

		  default:
			return new Response("Not found", {status: 404});
		}
	  });
	}

	// handleSession() implements our WebSocket-based chat protocol.
	async handleSession(webSocket, ip) {
	  // Accept our end of the WebSocket. This tells the runtime that we'll be terminating the
	  // WebSocket in JavaScript, not sending it elsewhere.
	  this.state.acceptWebSocket(webSocket);

	  // Set up our rate limiter client.
	  let limiterId = this.env.limiters.idFromName(ip);
	  let limiter = new RateLimiterClient(
		  () => this.env.limiters.get(limiterId),
		  err => webSocket.close(1011, err.stack));

	  // Create our session and add it to the sessions map.
	  let session = { limiterId, limiter, blockedMessages: [] };
	  // attach limiterId to the webSocket so it survives hibernation
	  webSocket.serializeAttachment({ ...webSocket.deserializeAttachment(), limiterId: limiterId.toString() });
	  this.sessions.set(webSocket, session);

	  // Queue "join" messages for all online users, to populate the client's roster.
	  for (let otherSession of this.sessions.values()) {
		if (otherSession.name) {
		  session.blockedMessages.push(JSON.stringify({joined: otherSession.name}));
		}
	  }

	  // Load the last 100 messages from the chat history stored on disk, and send them to the
	  // client.
	  let storage = await this.storage.list({reverse: true, limit: 100});
	  let backlog = [...storage.values()];
	  backlog.reverse();
	  backlog.forEach(value => {
		session.blockedMessages.push(value);
	  });
	}

	async webSocketMessage(webSocket, msg) {
	  try {
		let session = this.sessions.get(webSocket);
		if (session.quit) {
		  // Whoops, when trying to send to this WebSocket in the past, it threw an exception and
		  // we marked it broken. But somehow we got another message? I guess try sending a
		  // close(), which might throw, in which case we'll try to send an error, which will also
		  // throw, and whatever, at least we won't accept the message. (This probably can't
		  // actually happen. This is defensive coding.)
		  webSocket.close(1011, "WebSocket broken.");
		  return;
		}

		// Check if the user is over their rate limit and reject the message if so.
		if (!session.limiter.checkLimit()) {
		  webSocket.send(JSON.stringify({
			error: "Your IP is being rate-limited, please try again later."
		  }));
		  return;
		}

		// I guess we'll use JSON.
		let data = JSON.parse(msg);

		if (!session.name) {
		  // The first message the client sends is the user info message with their name. Save it
		  // into their session object.
		  session.name = "" + (data.name || "anonymous");
		  // attach name to the webSocket so it survives hibernation
		  webSocket.serializeAttachment({ ...webSocket.deserializeAttachment(), name: session.name });

		  // Don't let people use ridiculously long names. (This is also enforced on the client,
		  // so if they get here they are not using the intended client.)
		  if (session.name.length > 32) {
			webSocket.send(JSON.stringify({error: "Name too long."}));
			webSocket.close(1009, "Name too long.");
			return;
		  }

		  // Deliver all the messages we queued up since the user connected.
		  session.blockedMessages.forEach(queued => {
			webSocket.send(queued);
		  });
		  delete session.blockedMessages;

		  // Broadcast to all other connections that this user has joined.
		  this.broadcast({joined: session.name});

		  webSocket.send(JSON.stringify({ready: true}));
		  return;
		}

		// Construct sanitized message for storage and broadcast.
		data = { name: session.name, message: "" + data.message };

		// Block people from sending overly long messages. This is also enforced on the client,
		// so to trigger this the user must be bypassing the client code.
		if (data.message.length > 256) {
		  webSocket.send(JSON.stringify({error: "Message too long."}));
		  return;
		}

		// Add timestamp. Here's where this.lastTimestamp comes in -- if we receive a bunch of
		// messages at the same time (or if the clock somehow goes backwards????), we'll assign
		// them sequential timestamps, so at least the ordering is maintained.
		data.timestamp = Math.max(Date.now(), this.lastTimestamp + 1);
		this.lastTimestamp = data.timestamp;

		// Broadcast the message to all other WebSockets.
		let dataStr = JSON.stringify(data);
		this.broadcast(dataStr);

		// Save message.
		let key = new Date(data.timestamp).toISOString();
		await this.storage.put(key, dataStr);
	  } catch (err) {
		// Report any exceptions directly back to the client. As with our handleErrors() this
		// probably isn't what you'd want to do in production, but it's convenient when testing.
		webSocket.send(JSON.stringify({error: err.stack}));
	  }
	}

	// On "close" and "error" events, remove the WebSocket from the sessions list and broadcast
	// a quit message.
	async closeOrErrorHandler(webSocket) {
	  let session = this.sessions.get(webSocket) || {};
	  session.quit = true;
	  this.sessions.delete(webSocket);
	  if (session.name) {
		this.broadcast({quit: session.name});
	  }
	}

	async webSocketClose(webSocket, code, reason, wasClean) {
	  this.closeOrErrorHandler(webSocket)
	}

	async webSocketError(webSocket, error) {
	  this.closeOrErrorHandler(webSocket)
	}

	// broadcast() broadcasts a message to all clients.
	broadcast(message) {
	  // Apply JSON if we weren't given a string to start with.
	  if (typeof message !== "string") {
		message = JSON.stringify(message);
	  }

	  // Iterate over all the sessions sending them messages.
	  let quitters = [];
	  this.sessions.forEach((session, webSocket) => {
		if (session.name) {
		  try {
			webSocket.send(message);
		  } catch (err) {
			// Whoops, this connection is dead. Remove it from the map and arrange to notify
			// everyone below.
			session.quit = true;
			quitters.push(session);
			this.sessions.delete(webSocket);
		  }
		} else {
		  // This session hasn't sent the initial user info message yet, so we're not sending them
		  // messages yet (no secret lurking!). Queue the message to be sent later.
		  session.blockedMessages.push(message);
		}
	  });

	  quitters.forEach(quitter => {
		if (quitter.name) {
		  this.broadcast({quit: quitter.name});
		}
	  });
	}
  }

  // RateLimiterClient implements rate limiting logic on the caller's side.
class RateLimiterClient {
	// The constructor takes two functions:
	// * getLimiterStub() returns a new Durable Object stub for the RateLimiter object that manages
	//   the limit. This may be called multiple times as needed to reconnect, if the connection is
	//   lost.
	// * reportError(err) is called when something goes wrong and the rate limiter is broken. It
	//   should probably disconnect the client, so that they can reconnect and start over.
	constructor(getLimiterStub, reportError) {
	  this.getLimiterStub = getLimiterStub;
	  this.reportError = reportError;

	  // Call the callback to get the initial stub.
	  this.limiter = getLimiterStub();

	  // When `inCooldown` is true, the rate limit is currently applied and checkLimit() will return
	  // false.
	  this.inCooldown = false;
	}

	// Call checkLimit() when a message is received to decide if it should be blocked due to the
	// rate limit. Returns `true` if the message should be accepted, `false` to reject.
	checkLimit() {
	  if (this.inCooldown) {
		return false;
	  }
	  this.inCooldown = true;
	  this.callLimiter();
	  return true;
	}

	// callLimiter() is an internal method which talks to the rate limiter.
	async callLimiter() {
	  try {
		let response;
		try {
		  // Currently, fetch() needs a valid URL even though it's not actually going to the
		  // internet. We may loosen this in the future to accept an arbitrary string. But for now,
		  // we have to provide a dummy URL that will be ignored at the other end anyway.
		  response = await this.limiter.fetch("https://dummy-url", {method: "POST"});
		} catch (err) {
		  // `fetch()` threw an exception. This is probably because the limiter has been
		  // disconnected. Stubs implement E-order semantics, meaning that calls to the same stub
		  // are delivered to the remote object in order, until the stub becomes disconnected, after
		  // which point all further calls fail. This guarantee makes a lot of complex interaction
		  // patterns easier, but it means we must be prepared for the occasional disconnect, as
		  // networks are inherently unreliable.
		  //
		  // Anyway, get a new limiter and try again. If it fails again, something else is probably
		  // wrong.
		  this.limiter = this.getLimiterStub();
		  response = await this.limiter.fetch("https://dummy-url", {method: "POST"});
		}

		// The response indicates how long we want to pause before accepting more requests.
		let cooldown = +(await response.text());
		await new Promise(resolve => setTimeout(resolve, cooldown * 1000));

		// Done waiting.
		this.inCooldown = false;
	  } catch (err) {
		this.reportError(err);
	  }
	}
  }
