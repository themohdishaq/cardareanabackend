const { nanoid } = require("nanoid");
const { createInitialGameState, buildPlayerView } = require("./gameLogic");

// ── Instant Match ────────────────────────────────────────────────────────────
function handleMatchmaking(io, socket, queue, rooms, username) {
  // Prevent duplicate queue entries from reconnects
  const existing = queue.findIndex((p) => p.socketId === socket.id);
  if (existing !== -1) queue.splice(existing, 1);

  queue.push({ socketId: socket.id, username, socket });

  // Broadcast queue size to everyone waiting
  io.emit("waiting_update", { count: queue.length });

  if (queue.length >= 4) {
    const players = queue.splice(0, 4);
    const roomId = nanoid(8);

    rooms[roomId] = {
      players: players.map((p) => ({ id: p.socketId, username: p.username })),
      gameState: createInitialGameState(
        players.map((p) => ({ id: p.socketId, username: p.username }))
      ),
      isPrivate: false,
    };

    const gs = rooms[roomId].gameState;
    players.forEach((p) => {
      p.socket.join(roomId);
      p.socket.emit("game_start", { roomId });
      // Send per-player view so myHand/myWallet are correct for each client
      p.socket.emit("game_state", buildPlayerView(gs, p.socketId));
    });

    io.emit("waiting_update", { count: queue.length });
  }
}

// ── Create Private Room ──────────────────────────────────────────────────────
function handleCreateRoom(io, socket, rooms, username) {
  // Generate a human-friendly 6-char uppercase code
  const code = nanoid(6).toUpperCase();

  rooms[code] = {
    players: [{ id: socket.id, username }],
    gameState: null,   // created when room fills
    isPrivate: true,
    maxPlayers: 4,
  };

  socket.join(code);
  socket.emit("room_created", { code });
  io.to(code).emit("room_update", {
    code,
    players: rooms[code].players,
    started: false,
  });
}

// ── Join Private Room ────────────────────────────────────────────────────────
function handleJoinRoom(io, socket, rooms, code, username) {
  const room = rooms[code];

  if (!room) {
    socket.emit("room_error", { message: "Room not found." });
    return;
  }
  if (!room.isPrivate) {
    socket.emit("room_error", { message: "This is not a private room." });
    return;
  }
  if (room.players.length >= (room.maxPlayers || 4)) {
    socket.emit("room_error", { message: "Room is full." });
    return;
  }
  if (room.gameState) {
    socket.emit("room_error", { message: "Game already started." });
    return;
  }

  room.players.push({ id: socket.id, username });
  socket.join(code);

  io.to(code).emit("room_update", {
    code,
    players: room.players,
    started: false,
  });

  // Auto-start when 4 players join
  if (room.players.length === 4) {
    room.gameState = createInitialGameState(room.players);
    const gs = room.gameState;
    // Send game_start + per-player view to each socket individually
    for (const p of room.players) {
      io.to(p.id).emit("game_start", { roomId: code });
      io.to(p.id).emit("game_state", buildPlayerView(gs, p.id));
    }
  }
}

module.exports = { handleMatchmaking, handleCreateRoom, handleJoinRoom };
