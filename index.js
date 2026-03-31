const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { handleMatchmaking, handleCreateRoom, handleJoinRoom } = require("./matchmaking");
const {
  handleDrawCard,
  handleMatchMarket,
  handleMatchWallet,
  handleThrowCard,
  buildPlayerView,
} = require("./gameLogic");

const app = express();
const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: "bazargame.vercel.app" || "http://localhost:3000",
    methods: ["GET", "POST"],
  },
});

const queue = [];
const rooms = {};

io.on("connection", (socket) => {
  console.log("connected:", socket.id);

  // ── Matchmaking ───────────────────────────────────────────────────────────
  socket.on("join_lobby", ({ username }) => {
    handleMatchmaking(io, socket, queue, rooms, username);
  });
  socket.on("create_room", ({ username }) => {
    handleCreateRoom(io, socket, rooms, username);
  });
  socket.on("join_room", ({ code, username }) => {
    handleJoinRoom(io, socket, rooms, code, username);
  });

  // ── Request current game state (handles race condition on page mount) ────
  socket.on("request_game_state", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room?.gameState) return;
    socket.emit("game_state", buildPlayerView(room.gameState, socket.id));
  });

  // ── Game actions ──────────────────────────────────────────────────────────
  socket.on("draw_card",    ({ roomId }) => handleDrawCard(io, socket, rooms, roomId));
  socket.on("match_market", ({ roomId, handIndex }) => handleMatchMarket(io, socket, rooms, roomId, handIndex));
  socket.on("match_wallet", ({ roomId, targetPlayerId, handIndex }) => handleMatchWallet(io, socket, rooms, roomId, targetPlayerId, handIndex));
  socket.on("throw_card",   ({ roomId, cardSource, handIndex }) => handleThrowCard(io, socket, rooms, roomId, cardSource, handIndex));

  // ── WebRTC signaling (relay only — server never touches audio) ────────────
  // Offer: initiating peer → target peer
  socket.on("webrtc_offer", ({ targetId, offer, roomId }) => {
    io.to(targetId).emit("webrtc_offer", {
      fromId: socket.id,
      offer,
      roomId,
    });
  });

  // Answer: answering peer → initiating peer
  socket.on("webrtc_answer", ({ targetId, answer }) => {
    io.to(targetId).emit("webrtc_answer", {
      fromId: socket.id,
      answer,
    });
  });

  // ICE candidate exchange
  socket.on("webrtc_ice", ({ targetId, candidate }) => {
    io.to(targetId).emit("webrtc_ice", {
      fromId: socket.id,
      candidate,
    });
  });

  // Mic state change — broadcast to room so others can show speaking indicators
  socket.on("voice_state", ({ roomId, micOn }) => {
    socket.to(roomId).emit("peer_voice_state", {
      peerId: socket.id,
      micOn,
    });
  });

  // ── Disconnect ────────────────────────────────────────────────────────────
  socket.on("disconnect", () => {
    const qi = queue.findIndex((p) => p.socketId === socket.id);
    if (qi !== -1) queue.splice(qi, 1);

    for (const roomId in rooms) {
      const room = rooms[roomId];
      const pi = room.players.findIndex((p) => p.id === socket.id);
      if (pi !== -1) {
        room.players[pi].disconnected = true;
        io.to(roomId).emit("player_disconnected", { playerId: socket.id });
        // Notify peers to close their WebRTC connection to this peer
        io.to(roomId).emit("peer_left", { peerId: socket.id });
        break;
      }
    }
    console.log("disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 4000;
httpServer.listen(PORT, () => console.log(`WS server on :${PORT}`));
