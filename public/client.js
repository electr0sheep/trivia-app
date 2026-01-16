'use strict';

(function () {
	const socket = io({ autoConnect: false });

	// Screens
	const screenJoin = document.getElementById('screenJoin');
	const screenGame = document.getElementById('screenGame');

	// Join UI
	const joinBtn = document.getElementById('joinBtn');
	const nameInput = document.getElementById('joinNameInput');
	const joinError = document.getElementById('joinError');

	// Game UI
	const leaderboardEl = document.getElementById('leaderboard');
	const questionBox = document.getElementById('questionBox');
	const questionText = document.getElementById('questionText');
	const choicesEl = document.getElementById('choices');
	const revealBox = document.getElementById('revealBox');
	const resultMsg = document.getElementById('resultMsg');
	const timerEl = document.getElementById('timer');
	const phaseLabel = document.getElementById('phaseLabel');
	const categoryLabel = document.getElementById('categoryLabel');

	let joined = false;
	let myId = null;
	let myName = '';
	let lockedUntilQuestionId = null;
	let currentQuestion = null;
	let endsAt = 0;
	let tickTimer = null;
	let hasAnsweredThisRound = false;
	let autoJoinAttempted = false;
	let answerLocked = false;
	let choiceOrder = [];
	let aiHelpBtn = null;
	let aiModalBackdrop = null;
	let aiModalCard = null;
	let aiModalBody = null;
	let aiModalStatus = null;
	let aiHelpAvailable = true;
	let aiAbortController = null;

	const AI_HELP_ENDPOINT = '/api/ai-help';

	function showJoinScreen() {
		screenJoin.classList.remove('hidden');
		screenGame.classList.add('hidden');
	}
	function showGameScreen() {
		screenJoin.classList.add('hidden');
		screenGame.classList.remove('hidden');
	}

	function setPhaseLabel(text) {
		phaseLabel.textContent = text;
	}

	function msToClock(ms) {
		const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
		const s = String(totalSeconds % 60).padStart(2, '0');
		const m = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
		return `${m}:${s}`;
	}

	function injectAiStyles() {
		if (document.getElementById('ai-help-styles')) return;
		const style = document.createElement('style');
		style.id = 'ai-help-styles';
		style.textContent = `
			.ai-help-btn { margin-top: 12px; padding: 10px 12px; background: #0ea5e9; color: #f8fafc; border: none; border-radius: 8px; cursor: pointer; font-weight: 600; }
			.ai-help-btn:disabled { opacity: 0.6; cursor: not-allowed; }
			.ai-help-modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.55); display: flex; align-items: center; justify-content: center; z-index: 9999; }
			.ai-help-modal-backdrop.hidden { display: none !important; }
			.ai-help-modal-card { background: #0b172a; color: #e2e8f0; max-width: 720px; width: 92%; border-radius: 12px; padding: 16px 18px; box-shadow: 0 20px 60px rgba(0,0,0,0.35); }
			.ai-help-modal-card h3 { margin: 0 0 8px 0; color: #38bdf8; }
			.ai-help-modal-body { margin-top: 8px; max-height: 360px; overflow: auto; white-space: pre-wrap; line-height: 1.5; }
			.ai-help-close { float: right; cursor: pointer; color: #94a3b8; }
			.ai-help-status { font-size: 13px; margin-bottom: 4px; color: #38bdf8; }
		`;
		document.head.appendChild(style);
	}

	function ensureAiHelpUi() {
		if (aiHelpBtn) return;
		injectAiStyles();
		aiHelpBtn = document.createElement('button');
		aiHelpBtn.type = 'button';
		aiHelpBtn.className = 'ai-help-btn';
		aiHelpBtn.textContent = 'Get AI help';

		aiModalBackdrop = document.createElement('div');
		aiModalBackdrop.className = 'ai-help-modal-backdrop hidden';

		aiModalCard = document.createElement('div');
		aiModalCard.className = 'ai-help-modal-card';

		const closeBtn = document.createElement('span');
		closeBtn.textContent = '✕';
		closeBtn.className = 'ai-help-close';
		closeBtn.addEventListener('click', () => {
			aiModalBackdrop.classList.add('hidden');
			if (aiAbortController) aiAbortController.abort();
		});

		const title = document.createElement('h3');
		title.textContent = 'AI help';

		aiModalStatus = document.createElement('div');
		aiModalStatus.className = 'ai-help-status';
		aiModalStatus.textContent = 'Ready to ask about this question.';

		aiModalBody = document.createElement('div');
		aiModalBody.className = 'ai-help-modal-body';
		aiModalBody.textContent = '';

		aiModalCard.appendChild(closeBtn);
		aiModalCard.appendChild(title);
		aiModalCard.appendChild(aiModalStatus);
		aiModalCard.appendChild(aiModalBody);

		aiModalBackdrop.appendChild(aiModalCard);
		document.body.appendChild(aiModalBackdrop);

		aiHelpBtn.addEventListener('click', async () => {
			if (!currentQuestion) return;
			aiHelpBtn.disabled = true;
			aiModalStatus.textContent = 'Contacting AI helper...';
			aiModalStatus.style.color = '#38bdf8';
			aiModalBody.textContent = '';
			aiModalBackdrop.classList.remove('hidden');
			try {
				const answer = await fetchAiHelp(currentQuestion);
				aiModalStatus.textContent = 'AI response ready';
				aiModalStatus.style.color = '#34d399';
				aiModalBody.textContent = answer;
			} catch (err) {
				aiModalStatus.textContent = 'Unable to reach AI helper.';
				aiModalStatus.style.color = '#f97316';
				aiModalBody.textContent = err && err.message ? err.message : 'Unknown error';
			} finally {
				aiHelpBtn.disabled = false;
			}
		});
	}

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

	async function fetchAiHelp(question) {
		if (aiAbortController) aiAbortController.abort();
		aiAbortController = new AbortController();
		try {
			const res = await fetch(AI_HELP_ENDPOINT, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					question: {
						text: question.text,
						choices: question.choices || []
					}
				}),
				signal: aiAbortController.signal
			});
			if (!res.ok) {
				throw new Error('AI request failed. Try again soon.');
			}
			const data = await res.json();
			if (data && data.answer) return data.answer;
			return 'No answer returned.';
		} finally {
			aiAbortController = null;
		}
	}

	function startTick(toEndsAt) {
		endsAt = toEndsAt || 0;
		stopTick();
		if (!endsAt) {
			timerEl.textContent = '';
			return;
		}
		const update = () => {
			const msLeft = Math.max(0, endsAt - Date.now());
			timerEl.textContent = msToClock(msLeft);
		};
		update();
		tickTimer = setInterval(update, 250);
	}
	function stopTick() {
		if (tickTimer) clearInterval(tickTimer);
		tickTimer = null;
	}

	function renderLeaderboard(list) {
		leaderboardEl.innerHTML = '';
		list.forEach((p) => {
			const li = document.createElement('li');
			li.textContent = `${p.name} — ${p.score}`;
			if (p.id === myId) {
				li.style.color = '#16a34a';
				li.style.fontWeight = '700';
			}
			leaderboardEl.appendChild(li);
		});
	}

	function clearQuestionUI() {
		questionText.textContent = '';
		choicesEl.innerHTML = '';
		questionBox.classList.add('hidden');
	}

	function showQuestion(q) {
		const sameQuestion = currentQuestion && currentQuestion.id === q.id;
		currentQuestion = q;
		// Only reset answered state and choice order when a NEW question starts
		if (!sameQuestion) {
			hasAnsweredThisRound = false;
			choiceOrder = Array.from({ length: q.choices.length }, (_, i) => i);
			// Fisher-Yates shuffle for per-client randomized choice order
			for (let i = choiceOrder.length - 1; i > 0; i--) {
				const j = Math.floor(Math.random() * (i + 1));
				const t = choiceOrder[i];
				choiceOrder[i] = choiceOrder[j];
				choiceOrder[j] = t;
			}
		} else {
			// Ensure order matches length; if not, rebuild without shuffling
			if (!Array.isArray(choiceOrder) || choiceOrder.length !== q.choices.length) {
				choiceOrder = Array.from({ length: q.choices.length }, (_, i) => i);
			}
		}
		answerLocked = (lockedUntilQuestionId && q && q.id === lockedUntilQuestionId) ? true : false;
		resultMsg.textContent = '';
		revealBox.classList.add('hidden');
		questionBox.classList.remove('hidden');
		if (q.category) {
			categoryLabel.textContent = q.category;
			categoryLabel.classList.remove('hidden');
		} else {
			categoryLabel.textContent = '';
			categoryLabel.classList.add('hidden');
		}
		questionText.textContent = q.text;
		choicesEl.innerHTML = '';
		choiceOrder.forEach((origIdx) => {
			const c = q.choices[origIdx];
			const btn = document.createElement('button');
			btn.className = 'choice-btn';
			btn.dataset.label = c;
			btn.dataset.index = String(origIdx);
			btn.textContent = c;
			const shouldDisable = (answerLocked ? true : false) || hasAnsweredThisRound;
			btn.disabled = !!shouldDisable;
			btn.addEventListener('click', () => {
				if (hasAnsweredThisRound || answerLocked) return;
				hasAnsweredThisRound = true;
				btn.disabled = true;
				Array.from(choicesEl.children).forEach(ch => { ch.disabled = true; });
				const originalIndex = Number(btn.dataset.index);
				socket.emit('answer', { questionId: q.id, choiceIndex: originalIndex });
			});
			choicesEl.appendChild(btn);
		});
		ensureAiHelpUi();
		if (questionBox && aiHelpBtn && aiHelpBtn.parentElement !== questionBox) {
			questionBox.appendChild(aiHelpBtn);
		}
		if (aiHelpBtn) {
			aiHelpBtn.classList.remove('hidden');
			aiHelpBtn.disabled = false;
		}
	}

	function showReveal(q) {
		// Keep the question and choices visible, annotate answers
		revealBox.classList.add('hidden');
		questionBox.classList.remove('hidden');
		questionText.textContent = q.text;
		if (q.category) {
			categoryLabel.textContent = q.category;
			categoryLabel.classList.remove('hidden');
		} else {
			categoryLabel.textContent = '';
			categoryLabel.classList.add('hidden');
		}
		// If choices are not rendered (e.g., joined mid-reveal), render them disabled
		if (choicesEl.children.length !== q.choices.length) {
			choicesEl.innerHTML = '';
			// Use existing order if present, else default increasing order
			const order = Array.isArray(choiceOrder) && choiceOrder.length === q.choices.length
				? choiceOrder
				: Array.from({ length: q.choices.length }, (_, i) => i);
			order.forEach((origIdx) => {
				const c = q.choices[origIdx];
				const btn = document.createElement('button');
				btn.className = 'choice-btn';
				btn.dataset.label = c;
				btn.dataset.index = String(origIdx);
				btn.textContent = c;
				btn.disabled = true;
				choicesEl.appendChild(btn);
			});
		}
		// Mark correct and wrong with icons and colors
		Array.from(choicesEl.children).forEach((btn) => {
			btn.disabled = true;
			btn.classList.remove('correct', 'wrong');
			const base = btn.dataset.label || btn.textContent;
			const originalIndex = Number(btn.dataset.index);
			if (originalIndex === q.correctIndex) {
				btn.classList.add('correct');
				btn.textContent = `✓ ${base}`;
			} else {
				btn.classList.add('wrong');
				btn.textContent = `✕ ${base}`;
			}
		});
	}

	// Cookie helpers
	function setCookie(name, value, days) {
		const d = new Date();
		d.setTime(d.getTime() + (days * 24 * 60 * 60 * 1000));
		const expires = "expires=" + d.toUTCString();
		document.cookie = name + "=" + encodeURIComponent(value) + ";" + expires + ";path=/;SameSite=Lax";
	}
	function getCookie(name) {
		const cname = name + "=";
		const decodedCookie = document.cookie;
		const parts = decodedCookie.split(';');
		for (let i = 0; i < parts.length; i++) {
			let c = parts[i];
			while (c.charAt(0) === ' ') {
				c = c.substring(1);
			}
			if (c.indexOf(cname) === 0) {
				return decodeURIComponent(c.substring(cname.length, c.length));
			}
		}
		return "";
	}
	function getSavedName() {
		// Prefer cookie; fallback to localStorage for older sessions
		const fromCookie = getCookie('triviaName');
		if (fromCookie) return fromCookie;
		try {
			return localStorage.getItem('triviaName') || '';
		} catch {
			return '';
		}
	}
	function saveNameAll(name) {
		try {
			localStorage.setItem('triviaName', name);
		} catch {}
		setCookie('triviaName', name, 365);
	}

	joinBtn.addEventListener('click', () => {
		if (joined) return;
		const desired = nameInput.value.trim();
		if (!desired) {
			nameInput.focus();
			return;
		}
		if (joinError) {
			joinError.textContent = '';
			joinError.classList.add('hidden');
		}
		saveNameAll(desired);
		socket.connect();
		socket.emit('join', { name: desired });
	});
	nameInput.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') {
			joinBtn.click();
		}
	});

	// Socket events
	socket.on('connect', () => {
		// no-op
	});

	socket.on('join_error', (payload) => {
		if (joinError && payload && payload.reason) {
			joinError.textContent = payload.reason;
			joinError.classList.remove('hidden');
		}
		// Allow user to try again
	});

	socket.on('joined', (payload) => {
		myId = payload.self.id;
		myName = payload.self.name || '';
		saveNameAll(myName);
		lockedUntilQuestionId = payload.self.lockedUntilQuestionId || null;
		joined = true;
		showGameScreen();
		renderLeaderboard(payload.leaderboard || []);
		if (payload.phase === 'question' && payload.question) {
			setPhaseLabel('Question');
			showQuestion(payload.question);
			startTick(payload.question.endsAt);
		} else if (payload.phase === 'reveal' && payload.reveal) {
			setPhaseLabel('Reveal');
			showReveal(payload.reveal);
			stopTick();
			if (window.AdService && typeof window.AdService.onReveal === 'function') {
				window.AdService.onReveal();
			}
		} else {
			setPhaseLabel('Waiting for next question...');
			stopTick();
			clearQuestionUI();
			categoryLabel.textContent = '';
			categoryLabel.classList.add('hidden');
		}
	});

	socket.on('leaderboard', ({ leaderboard }) => {
		renderLeaderboard(leaderboard || []);
	});

	socket.on('question', (q) => {
		setPhaseLabel('Question');
		if (window.AdService && typeof window.AdService.onQuestion === 'function') {
			window.AdService.onQuestion();
		}
		// Unlock answering when a new question arrives
		if (lockedUntilQuestionId && q && q.id !== lockedUntilQuestionId) {
			answerLocked = false;
			lockedUntilQuestionId = null;
		}
		showQuestion(q);
		startTick(q.endsAt);
	});

	socket.on('reveal', (q) => {
		setPhaseLabel('Reveal');
		showReveal(q);
		stopTick();
		if (window.AdService && typeof window.AdService.onReveal === 'function') {
			window.AdService.onReveal();
		}
	});

	socket.on('answer_result', (res) => {
		if (!res.ok) {
			resultMsg.textContent = res.reason || 'Unable to submit.';
			resultMsg.style.color = '#f59e0b';
			return;
		}
		if (res.correct) {
			let rankSuffix = '';
			if (res.rankWord) {
				rankSuffix = ` (You were the ${res.rankWord} person to answer correctly)`;
			} else if (res.rank) {
				rankSuffix = ` (rank #${res.rank})`;
			}
			let base = `Correct! +${res.points} points${rankSuffix}`;
			if (res.humor) base += ` ${res.humor}`;
			resultMsg.textContent = base;
			resultMsg.style.color = '#16a34a';
		} else {
			let base = 'Not quite. Better luck on the next one!';
			if (res.humor) base += ` ${res.humor}`;
			resultMsg.textContent = base;
			resultMsg.style.color = '#ef4444';
		}
		if (Array.isArray(res.leaderboard)) {
			renderLeaderboard(res.leaderboard);
		}
	});

	// Prefill saved name and auto-join if present
	const saved = getSavedName();
	if (saved) {
		nameInput.value = saved;
		if (!autoJoinAttempted) {
			autoJoinAttempted = true;
			socket.connect();
			socket.emit('join', { name: saved });
		}
	} else {
		showJoinScreen();
	}

	// AI help always available; no dependency on ad skip
})();
