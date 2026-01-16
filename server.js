'use strict';

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { questions } = require('./src/questions');
const { toWordsOrdinal } = require('number-to-words');

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = 'PutYourKeyHere';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3-flash-preview';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const QUESTION_DURATION_MS = 10000; // 10s to answer
const REVEAL_DURATION_MS = 3000; // 3s reveal before next question
const IDLE_BETWEEN_MS = 1500; // short breather
const HUMOR_MODE = String(process.env.HUMOR_MODE || '').toLowerCase() === 'true';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
	cors: {
		origin: '*'
	}
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/**
 * Player and Game State
 */
/** @type {Map<string, { id: string, name: string, score: number, connected: boolean, lockedUntilQuestionId?: string, lastAnswer?: { questionId: string, correct: boolean, pointsAwarded: number } }>} */
const playerIdToPlayer = new Map();
/** Map by name to player id to allow reclaiming names */
const playerNameToId = new Map();

/** Game loop state */
let currentQuestionIndex = -1;
let currentPhase = 'idle'; // 'question' | 'reveal' | 'idle'
let currentQuestion = null; // { id, text, choices, correctIndex, explanation? }
let questionStartedAt = 0;
let questionEndsAt = 0;
/** @type {Map<string, { choiceIndex: number, correct: boolean, points: number, answeredAt: number }>} */
let submissionsThisRound = new Map();
let nextTimer = null;
/** Shuffled order control */
let shuffledOrder = [];
let shuffledCursor = -1;

/**
 * Utilities
 */
function now() {
	return Date.now();
}

function sanitizeName(raw) {
	const base = String(raw || '').trim().slice(0, 20);
	return base || 'Player';
}

function getUniqueName(desired) {
	const base = sanitizeName(desired);
	if (!playerNameToId.has(base)) return base;
	let suffix = 2;
	while (playerNameToId.has(`${base} ${suffix}`)) {
		suffix += 1;
	}
	return `${base} ${suffix}`;
}

function sortPlayersForLeaderboard() {
	return Array.from(playerIdToPlayer.values())
		.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
		.slice(0, 100);
}

function publicLeaderboard() {
	return sortPlayersForLeaderboard().map(p => ({
		id: p.id,
		name: p.name,
		score: p.score
	}));
}

function publicQuestionPayload(includeAnswer = false) {
	if (!currentQuestion) return null;
	const payload = {
		id: currentQuestion.id,
		text: currentQuestion.text,
		category: currentQuestion.category || 'General',
		choices: currentQuestion.choices,
		endsAt: questionEndsAt
	};
	if (includeAnswer) {
		payload.correctIndex = currentQuestion.correctIndex;
		payload.explanation = currentQuestion.explanation || null;
	}
	return payload;
}

function broadcastState() {
	io.emit('leaderboard', { leaderboard: publicLeaderboard() });
	if (currentPhase === 'question') {
		io.emit('question', publicQuestionPayload(false));
	} else if (currentPhase === 'reveal') {
		io.emit('reveal', publicQuestionPayload(true));
	}
}

/**
 * Shuffle helpers: build a new randomized order of question indices
 * ensuring no repeats until all questions are asked.
 */
function fisherYatesShuffle(array) {
	for (let i = array.length - 1; i > 0; i -= 1) {
		const j = Math.floor(Math.random() * (i + 1));
		const t = array[i];
		array[i] = array[j];
		array[j] = t;
	}
	return array;
}

function buildShuffledOrder() {
	const count = questions.length;
	const order = Array.from({ length: count }, (_, i) => i);
	shuffledOrder = fisherYatesShuffle(order);
	shuffledCursor = -1;
}

/**
 * AI helper proxy to avoid browser CORS issues.
 * Expects body: { question: { text: string, choices: string[] } }
 */
function buildAiPrompt(question) {
	if (!question) return 'No question provided.';
	let prompt = `Here is a trivia question. Reply with the single most likely correct answer and a one-sentence explanation.\n\nQuestion: ${question.text}\nChoices:\n`;
	if (Array.isArray(question.choices)) {
		question.choices.forEach((c, idx) => {
			prompt += `- (${idx + 1}) ${c}\n`;
		});
	}
	return prompt;
}

app.post('/api/ai-help', async (req, res) => {
	try {
		if (!GEMINI_API_KEY) {
			return res.status(500).json({ error: 'Gemini API key missing. Set GEMINI_API_KEY env var.' });
		}
		const { question } = req.body || {};
		if (!question || !question.text) {
			return res.status(400).json({ error: 'Missing question text' });
		}
		const payload = {
			contents: [
				{
					role: 'user',
					parts: [
						{ text: 'You are a concise trivia coach. Provide the single most likely correct choice and a one-sentence reasoning. If unsure, give your best guess.' }
					]
				},
				{
					role: 'user',
					parts: [{ text: buildAiPrompt(question) }]
				}
			],
			generationConfig: {
				temperature: 0.2,
				maxOutputTokens: 200
			}
		};
		const upstream = await fetch(`${GEMINI_ENDPOINT}?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload)
		});
		if (!upstream.ok) {
			const text = await upstream.text();
			return res.status(502).json({ error: 'Upstream AI request failed', details: text.slice(0, 200) });
		}
		const data = await upstream.json();
		const answer = data &&
			data.candidates &&
			data.candidates[0] &&
			data.candidates[0].content &&
			data.candidates[0].content.parts &&
			data.candidates[0].content.parts[0] &&
			data.candidates[0].content.parts[0].text
			? data.candidates[0].content.parts[0].text.trim()
			: null;
		return res.json({ answer });
	} catch (err) {
		return res.status(500).json({ error: 'AI helper unavailable', details: err.message });
	}
});

function startNextQuestion() {
	if (questions.length === 0) {
		currentPhase = 'idle';
		broadcastState();
		return;
	}
	// Rebuild order when starting or when exhausted, or if question count changed
	if (!Array.isArray(shuffledOrder) ||
		shuffledOrder.length !== questions.length ||
		shuffledCursor >= shuffledOrder.length - 1) {
		buildShuffledOrder();
	}
	shuffledCursor += 1;
	currentQuestionIndex = shuffledOrder[shuffledCursor];
	currentPhase = 'question';
	currentQuestion = questions[currentQuestionIndex];
	questionStartedAt = now();
	questionEndsAt = questionStartedAt + QUESTION_DURATION_MS;
	submissionsThisRound = new Map();

	// Optional: log question start for visibility
	// console.log(`Question ${currentQuestion.id} started: ${currentQuestion.text}`);

	broadcastState();

	clearTimeout(nextTimer);
	nextTimer = setTimeout(endQuestionAndReveal, QUESTION_DURATION_MS);
}

function endQuestionAndReveal() {
	currentPhase = 'reveal';
	// Tally is already applied when answers come in; just reveal
	broadcastState();

	clearTimeout(nextTimer);
	nextTimer = setTimeout(() => {
		currentPhase = 'idle';
		broadcastState();
		clearTimeout(nextTimer);
		nextTimer = setTimeout(startNextQuestion, IDLE_BETWEEN_MS);
	}, REVEAL_DURATION_MS);
}

/**
 * Scoring
 * Points for a correct answer:
 * (10 * current number of connected players) - (10 * number of correct guesses so far)
 * Note: "correct guesses so far" does NOT include the current correct guess.
 */
function isCorrectChoice(choiceIndex) {
	return Number(choiceIndex) === currentQuestion.correctIndex;
}

/**
 * Humor messages when HUMOR_MODE is enabled.
 */
function getHumorMessageFor(question, correct, choiceIndex) {
	if (!question) return null;
	// Generic pool
	if (correct) {
		const pool = [
			"Correct — you're on a roll!",
			'You nailed it! 🎯',
			'Right answer, right attitude.',
			'Spot on! Your brain deserves a snack.',
			'Boom! Knowledge unlocked.'
		];
		return pool[Math.floor(Math.random() * pool.length)];
	} else {
		// Prefer per-question wrong humor from questions.js
		if (question.wrongHumor) return question.wrongHumor;
		// Fallback one-liner if not provided
		return 'We’ll call that a warm-up. The next one’s yours.';
	}
}

/**
 * Socket.IO events
 */
io.on('connection', socket => {
	const playerId = socket.id;

	socket.on('join', ({ name }) => {
		// Reclaim by name if possible
		let finalName = sanitizeName(name);
		if (finalName && playerNameToId.has(finalName)) {
			const existingId = playerNameToId.get(finalName);
			const existing = playerIdToPlayer.get(existingId);
			if (existing) {
				// If the name is used by a currently connected user, disallow
				const inUse = io.sockets.sockets.has(existingId);
				if (inUse) {
					socket.emit('join_error', { reason: 'That name is already taken. Please choose a different name.' });
					return;
				}
				// Otherwise, allow reclaim (same name, previous player disconnected)
				playerIdToPlayer.delete(existingId);
				playerNameToId.set(finalName, playerId);
				playerIdToPlayer.set(playerId, {
					id: playerId,
					name: finalName,
					score: existing.score,
					connected: true
				});
			}
		}

		// Create fresh if not already set by reclaim
		if (!playerIdToPlayer.has(playerId)) {
			if (!finalName) finalName = sanitizeName('Player');
			// If name already exists at this point, disallow
			if (playerNameToId.has(finalName)) {
				socket.emit('join_error', { reason: 'That name is already taken. Please choose a different name.' });
				return;
			}
			playerNameToId.set(finalName, playerId);
			playerIdToPlayer.set(playerId, {
				id: playerId,
				name: finalName,
				score: 0,
				connected: true
			});
		} else {
			// Ensure connected flag true
			const p = playerIdToPlayer.get(playerId);
			p.connected = true;
		}

		// Lock answering if joining during an active question
		const playerForEmit = playerIdToPlayer.get(playerId);
		if (currentPhase === 'question' && currentQuestion) {
			playerForEmit.lockedUntilQuestionId = currentQuestion.id;
		} else {
			delete playerForEmit.lockedUntilQuestionId;
		}

		socket.emit('joined', {
			self: playerForEmit,
			leaderboard: publicLeaderboard(),
			phase: currentPhase,
			question: currentPhase === 'question' ? publicQuestionPayload(false) : null,
			reveal: currentPhase === 'reveal' ? publicQuestionPayload(true) : null
		});
		broadcastState();
	});

	socket.on('answer', ({ questionId, choiceIndex }) => {
		// Validate phase and question
		if (currentPhase !== 'question') {
			socket.emit('answer_result', { ok: false, reason: 'Not accepting answers right now.' });
			return;
		}
		if (!currentQuestion || questionId !== currentQuestion.id) {
			socket.emit('answer_result', { ok: false, reason: 'Question no longer active.' });
			return;
		}
		// One submission per round
		if (submissionsThisRound.has(playerId)) {
			socket.emit('answer_result', { ok: false, reason: 'You already answered.' });
			return;
		}
		const player = playerIdToPlayer.get(playerId);
		if (!player) {
			socket.emit('answer_result', { ok: false, reason: 'Unknown player.' });
			return;
		}
		// Prevent answering if they joined mid-question (locked for this question id)
		if (player.lockedUntilQuestionId && currentQuestion && player.lockedUntilQuestionId === currentQuestion.id) {
			socket.emit('answer_result', { ok: false, reason: 'You joined mid-question. Please wait for the next question.' });
			return;
		}
		const correct = isCorrectChoice(choiceIndex);
		let points = 0;
		let rank = null;
		let rankWord = null;
		let humor = null;
		if (correct) {
			const correctSoFar = Array.from(submissionsThisRound.values()).filter(s => s.correct).length;
			rank = correctSoFar + 1;
			rankWord = toWordsOrdinal(rank);
			const numConnectedPlayers = Array.from(playerIdToPlayer.values()).filter(p => p.connected).length;
			points = (10 * numConnectedPlayers) - (10 * correctSoFar);
		}
		if (HUMOR_MODE) {
			humor = getHumorMessageFor(currentQuestion, correct, Number(choiceIndex));
		}
		submissionsThisRound.set(playerId, {
			choiceIndex: Number(choiceIndex),
			correct,
			points,
			answeredAt: now()
		});
		if (correct) {
			player.score += points;
		}
		player.lastAnswer = {
			questionId,
			correct,
			pointsAwarded: points
		};
		socket.emit('answer_result', { ok: true, correct, points, rank, rankWord, humor, leaderboard: publicLeaderboard() });
		io.emit('leaderboard', { leaderboard: publicLeaderboard() });
	});

	socket.on('disconnect', () => {
		const player = playerIdToPlayer.get(playerId);
		if (player) {
			player.connected = false;
			// Keep their score so they can rejoin later
		}
	});
});

/**
 * Start loop
 */
server.listen(PORT, () => {
	// Start first question shortly after server starts
	setTimeout(startNextQuestion, 1000);
	console.log(`Trivia server listening on http://localhost:${PORT}`);
});

module.exports = { app, server, io };
