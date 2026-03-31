// ── Deck Utilities ───────────────────────────────────────────────────────────
const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

function buildDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank, id: `${rank}${suit}` });
    }
  }
  return deck;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── Scoring ──────────────────────────────────────────────────────────────────
// Numbers 2-9 → 5pts, 10/J/Q/K → 10pts, Ace → 20pts
function cardPoints(card) {
  if (card.rank === "A") return 20;
  if (["10", "J", "Q", "K"].includes(card.rank)) return 10;
  return 5; // 2-9
}

function walletScore(wallet) {
  return wallet.reduce((sum, c) => sum + cardPoints(c), 0);
}

// ── Game State Factory ───────────────────────────────────────────────────────
function createInitialGameState(players) {
  const deck = shuffle(buildDeck());
  const hands = {};

  for (const p of players) {
    hands[p.id] = deck.splice(0, 4);
  }

  const market = deck.splice(0, 4);

  const wallets = {};
  const lockedSets = {};
  for (const p of players) {
    wallets[p.id] = [];
    lockedSets[p.id] = [];
  }

  return {
    players,
    hands,
    market,
    deck,
    wallets,
    lockedSets,
    turn: 0,
    round: 1,
    phase: "playing",
    drawnCard: null,
    turnChaining: false,
    lastAction: null,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function isActivePlayer(gs, socketId) {
  return gs.players[gs.turn]?.id === socketId;
}

function advanceTurn(gs) {
  gs.turn = (gs.turn + 1) % gs.players.length;
  gs.drawnCard = null;
  gs.turnChaining = false;
  if (gs.turn === 0) gs.round++;
}

// Get top card of a wallet (last element)
function walletTop(wallet) {
  return wallet.length > 0 ? wallet[wallet.length - 1] : null;
}

// After adding cards to a wallet, check for 4-of-a-kind lock
function checkAndLock(gs, playerId) {
  const wallet = gs.wallets[playerId];
  if (wallet.length < 4) return;

  const topRank = wallet[wallet.length - 1].rank;
  let count = 0;
  for (let i = wallet.length - 1; i >= 0; i--) {
    if (wallet[i].rank === topRank) count++;
    else break;
  }

  if (count >= 4) {
    const locked = wallet.splice(wallet.length - count, count);
    gs.lockedSets[playerId].push(locked);
  }
}

function findMarketMatches(market, rank) {
  return market
    .map((c, i) => ({ card: c, index: i }))
    .filter(({ card }) => card.rank === rank);
}

// ── Check game end ────────────────────────────────────────────────────────────
function checkGameEnd(gs) {
  if (gs.phase !== "endgame") return;

  const anyCards = gs.players.some((p) => (gs.hands[p.id] || []).length > 0);
  if (anyCards) return;

  gs.phase = "ended";

  const scores = {};
  for (const p of gs.players) {
    let score = walletScore(gs.wallets[p.id]);
    for (const lockedGroup of gs.lockedSets[p.id]) {
      score += walletScore(lockedGroup);
    }
    scores[p.id] = score;
  }
  gs.scores = scores;

  let maxScore = -1;
  let winner = null;
  for (const p of gs.players) {
    if (scores[p.id] > maxScore) {
      maxScore = scores[p.id];
      winner = p;
    }
  }
  gs.winner = winner;
}

// ── Build per-player view ────────────────────────────────────────────────────
function buildPlayerView(gs, forSocketId) {
  const activePlayer = gs.players[gs.turn];

  const walletTops = {};
  const myWallet = gs.wallets[forSocketId] || [];
  const opponentWalletSizes = {};

  for (const p of gs.players) {
    const top = walletTop(gs.wallets[p.id]);
    walletTops[p.id] = top || null;
    if (p.id !== forSocketId) {
      opponentWalletSizes[p.id] = gs.wallets[p.id].length;
    }
  }

  const lockedSetCounts = {};
  for (const p of gs.players) {
    lockedSetCounts[p.id] = gs.lockedSets[p.id].length;
  }

  return {
    players: gs.players,
    market: gs.market,
    deckCount: gs.deck.length,
    turn: gs.turn,
    round: gs.round,
    phase: gs.phase,
    status: gs.phase === "ended" ? "ended" : "playing",
    lastAction: gs.lastAction,
    myHand: gs.hands[forSocketId] || [],
    myWallet,
    myWalletSize: myWallet.length,
    drawnCard: forSocketId === activePlayer?.id ? gs.drawnCard : null,
    turnChaining: gs.turnChaining,
    opponentCardCounts: Object.fromEntries(
      gs.players.filter((p) => p.id !== forSocketId).map((p) => [p.id, (gs.hands[p.id] || []).length])
    ),
    walletTops,
    opponentWalletSizes,
    lockedSetCounts,
    scores: gs.scores || null,
    winner: gs.winner || null,
  };
}

// ── Emit updated state ────────────────────────────────────────────────────────
function emitGameUpdate(io, roomId, room) {
  const gs = room.gameState;
  for (const p of gs.players) {
    io.to(p.id).emit("game_update", buildPlayerView(gs, p.id));
  }
  io.to(roomId).emit("turn_change", { turn: gs.turn, activePlayer: gs.players[gs.turn] });
  if (gs.phase === "ended") {
    io.to(roomId).emit("game_end", {
      winner: gs.winner,
      scores: gs.scores,
      players: gs.players,
    });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// ACTIONS
// ══════════════════════════════════════════════════════════════════════════════

// ── ACTION: Draw card from deck ───────────────────────────────────────────────
function handleDrawCard(io, socket, rooms, roomId) {
  const room = rooms[roomId];
  if (!room?.gameState) return;
  const gs = room.gameState;

  if (!isActivePlayer(gs, socket.id)) {
    socket.emit("action_error", { message: "Not your turn." });
    return;
  }
  if (gs.phase !== "playing") {
    socket.emit("action_error", { message: "Deck phase is over. Play from hand." });
    return;
  }
  if (gs.drawnCard) {
    socket.emit("action_error", { message: "Already drew. Match or throw a card." });
    return;
  }
  if (gs.deck.length === 0) {
    gs.phase = "endgame";
    gs.lastAction = { type: "phase_change", message: "Deck empty — endgame begins!" };
    emitGameUpdate(io, roomId, room);
    return;
  }

  gs.drawnCard = gs.deck.shift();
  gs.turnChaining = false;
  gs.lastAction = {
    type: "draw",
    player: gs.players[gs.turn],
  };

  emitGameUpdate(io, roomId, room);
}

// ── ACTION: Match a card with market cards ────────────────────────────────────
// The active card is either:
//   - the drawn card (handIndex omitted / undefined)
//   - a hand card    (handIndex = index into myHand)
// Works in both "playing" and "endgame" phases.
// Collecting succeeds → cards go to wallet → turn chains (player acts again).
function handleMatchMarket(io, socket, rooms, roomId, handIndex) {
  const room = rooms[roomId];
  if (!room?.gameState) return;
  const gs = room.gameState;

  if (!isActivePlayer(gs, socket.id)) {
    socket.emit("action_error", { message: "Not your turn." });
    return;
  }
  if (gs.phase === "ended") return;

  const usingHandCard = handIndex !== undefined && handIndex !== null;
  let activeCard;

  if (usingHandCard) {
    // Hand-card play: no drawn card must be pending
    if (gs.drawnCard) {
      socket.emit("action_error", { message: "Resolve your drawn card first (match or throw it)." });
      return;
    }
    const hand = gs.hands[socket.id];
    if (!hand || handIndex < 0 || handIndex >= hand.length) {
      socket.emit("action_error", { message: "Invalid hand card." });
      return;
    }
    activeCard = hand[handIndex];
  } else {
    // Drawn-card play
    if (!gs.drawnCard) {
      socket.emit("action_error", { message: "Draw a card first, or tap a hand card to play it." });
      return;
    }
    activeCard = gs.drawnCard;
  }

  const matches = findMarketMatches(gs.market, activeCard.rank);
  if (matches.length === 0) {
    socket.emit("action_error", { message: "That card does not match any market card." });
    return;
  }

  // Remove active card from its source
  if (usingHandCard) {
    gs.hands[socket.id].splice(handIndex, 1);
  } else {
    gs.drawnCard = null;
  }

  // Collect active card + all matching market cards into wallet
  const collected = [activeCard];
  const matchedIndices = matches.map((m) => m.index).sort((a, b) => b - a);
  for (const idx of matchedIndices) {
    collected.push(gs.market.splice(idx, 1)[0]);
  }

  gs.wallets[socket.id].push(...collected);
  checkAndLock(gs, socket.id);

  gs.lastAction = {
    type: "match_market",
    player: gs.players[gs.turn],
    collected,
    matchCount: matches.length,
    fromHand: usingHandCard,
  };

  gs.drawnCard = null;
  gs.turnChaining = true;

  if (gs.deck.length === 0 && gs.phase === "playing") {
    gs.phase = "endgame";
  }

  checkGameEnd(gs);
  emitGameUpdate(io, roomId, room);
}

// ── ACTION: Match a card with an opponent's wallet top ────────────────────────
// The active card is either drawn card or a hand card (see handleMatchMarket).
// Steals all consecutive same-rank cards from the top of target's wallet.
function handleMatchWallet(io, socket, rooms, roomId, targetPlayerId, handIndex) {
  const room = rooms[roomId];
  if (!room?.gameState) return;
  const gs = room.gameState;

  if (!isActivePlayer(gs, socket.id)) {
    socket.emit("action_error", { message: "Not your turn." });
    return;
  }
  if (gs.phase === "ended") return;

  if (targetPlayerId === socket.id) {
    socket.emit("action_error", { message: "Cannot match your own wallet." });
    return;
  }

  const usingHandCard = handIndex !== undefined && handIndex !== null;
  let activeCard;

  if (usingHandCard) {
    if (gs.drawnCard) {
      socket.emit("action_error", { message: "Resolve your drawn card first (match or throw it)." });
      return;
    }
    const hand = gs.hands[socket.id];
    if (!hand || handIndex < 0 || handIndex >= hand.length) {
      socket.emit("action_error", { message: "Invalid hand card." });
      return;
    }
    activeCard = hand[handIndex];
  } else {
    if (!gs.drawnCard) {
      socket.emit("action_error", { message: "Draw a card first, or tap a hand card to play it." });
      return;
    }
    activeCard = gs.drawnCard;
  }

  const targetWallet = gs.wallets[targetPlayerId];
  const topCard = walletTop(targetWallet);
  if (!topCard || topCard.rank !== activeCard.rank) {
    socket.emit("action_error", { message: "That card does not match that wallet's top card." });
    return;
  }

  // Remove active card from its source
  if (usingHandCard) {
    gs.hands[socket.id].splice(handIndex, 1);
  } else {
    gs.drawnCard = null;
  }

  // Steal all consecutive matching top cards from target wallet
  const collected = [activeCard];
  const topRank = topCard.rank;
  while (targetWallet.length > 0 && walletTop(targetWallet).rank === topRank) {
    collected.push(targetWallet.pop());
  }

  gs.wallets[socket.id].push(...collected);
  checkAndLock(gs, socket.id);

  gs.lastAction = {
    type: "match_wallet",
    player: gs.players[gs.turn],
    targetPlayer: gs.players.find((p) => p.id === targetPlayerId),
    collected,
    fromHand: usingHandCard,
  };

  gs.drawnCard = null;
  gs.turnChaining = true;

  if (gs.deck.length === 0 && gs.phase === "playing") {
    gs.phase = "endgame";
  }

  checkGameEnd(gs);
  emitGameUpdate(io, roomId, room);
}

// ── ACTION: Throw a card to market (ends turn) ────────────────────────────────
// playing phase:
//   cardSource "drawn"  — throw the drawn card (requires drawnCard)
//   cardSource "hand"   — throw a hand card directly:
//                         • if drawnCard exists → swap (drawn card goes to hand)
//                         • if no drawnCard    → direct throw, ends turn immediately
// endgame phase: throw any hand card
function handleThrowCard(io, socket, rooms, roomId, cardSource, handIndex) {
  const room = rooms[roomId];
  if (!room?.gameState) return;
  const gs = room.gameState;

  if (!isActivePlayer(gs, socket.id)) {
    socket.emit("action_error", { message: "Not your turn." });
    return;
  }

  let thrownCard;

  if (gs.phase === "playing") {
    if (cardSource === "drawn") {
      if (!gs.drawnCard) {
        socket.emit("action_error", { message: "Draw a card first." });
        return;
      }
      thrownCard = gs.drawnCard;
      gs.drawnCard = null;
    } else if (cardSource === "hand") {
      const hand = gs.hands[socket.id];
      if (handIndex === undefined || handIndex < 0 || handIndex >= hand.length) {
        socket.emit("action_error", { message: "Invalid hand card index." });
        return;
      }
      thrownCard = hand.splice(handIndex, 1)[0];
      if (gs.drawnCard) {
        // Swap: drawn card goes into hand
        hand.push(gs.drawnCard);
        gs.drawnCard = null;
      }
      // No drawnCard: straight throw from hand, turn ends normally below
    } else {
      socket.emit("action_error", { message: "Invalid card source." });
      return;
    }
  } else if (gs.phase === "endgame") {
    const hand = gs.hands[socket.id];
    if (!hand || hand.length === 0) {
      socket.emit("action_error", { message: "No cards left in hand." });
      return;
    }
    if (handIndex === undefined || handIndex < 0 || handIndex >= hand.length) {
      socket.emit("action_error", { message: "Pick a card from your hand to throw." });
      return;
    }
    thrownCard = hand.splice(handIndex, 1)[0];
  } else {
    return;
  }

  gs.market.push(thrownCard);

  gs.lastAction = {
    type: "throw",
    player: gs.players[gs.turn],
    card: thrownCard,
  };

  advanceTurn(gs);
  checkGameEnd(gs);
  emitGameUpdate(io, roomId, room);
}

module.exports = {
  createInitialGameState,
  handleDrawCard,
  handleMatchMarket,
  handleMatchWallet,
  handleThrowCard,
  buildPlayerView,
  cardPoints,
  walletScore,
};
