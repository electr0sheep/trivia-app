"use strict";

(function () {
	/**
	 * House-only ad helper: show local overlay interstitial with fun creatives.
	 */
	let initialized = false;
	let overlayEl = null;
	let cardEl = null;
	let mediaEl = null;
	let skipBtnEl = null;
	let metaEl = null;
	let showing = false;
	let showTimer = null;
	let allowClose = false;
	let actionsEl = null;
	let skipAllCashBtn = null;
	let skipAllPointsBtn = null;

	function getSkipAll() {
		try {
			return localStorage.getItem('skipAllAds') === 'true';
		} catch {
			return false;
		}
	}
	function setSkipAll(val) {
		try {
			localStorage.setItem('skipAllAds', val ? 'true' : 'false');
		} catch {}
	}

	function initOnce() {
		if (initialized) return;
		initialized = true;
	}

	// ----- House interstitial (no network) -----
	const HOUSE_MIN_MS = 10000;
	const HOUSE_SKIP_MS = 5000;
	const creatives = [
		{
			id: "fun01",
			title: "Totally Real Ad",
			imageUrl: "https://images.unsplash.com/photo-1529070538774-1843cb3265df?q=80&w=1200&auto=format&fit=crop",
			clickUrl: "https://www.example.com/",
			brand: "Definitely Legit Co."
		},
		{
			id: "fun02",
			title: "Buy More Knowledge",
			imageUrl: "https://images.unsplash.com/photo-1526779259212-939e64788e3c?q=80&w=1200&auto=format&fit=crop",
			clickUrl: "https://www.example.com/",
			brand: "TriviaBoost"
		},
		{
			id: "fun03",
			title: "Sponsored by Air",
			imageUrl: "https://images.unsplash.com/photo-1540961492257-c6f2a02c9f2f?q=80&w=1200&auto=format&fit=crop",
			clickUrl: "https://www.example.com/",
			brand: "Air"
		}
	];
	function ensureOverlay() {
		if (overlayEl) return;
		overlayEl = document.createElement('div');
		overlayEl.id = 'adOverlay';
		overlayEl.className = 'ad-overlay hidden';

		cardEl = document.createElement('div');
		cardEl.className = 'ad-card';

		mediaEl = document.createElement('a');
		mediaEl.className = 'ad-media-link';
		mediaEl.target = '_blank';
		mediaEl.rel = 'noopener noreferrer';
		const img = document.createElement('img');
		img.className = 'ad-media';
		img.alt = 'Sponsored';
		mediaEl.appendChild(img);

		metaEl = document.createElement('div');
		metaEl.className = 'ad-meta';
		metaEl.textContent = 'Sponsored';

		actionsEl = document.createElement('div');
		actionsEl.className = 'ad-actions';
		// Cash button
		skipAllCashBtn = document.createElement('button');
		skipAllCashBtn.type = 'button';
		skipAllCashBtn.className = 'ad-action-btn ad-action-cash';
		skipAllCashBtn.textContent = 'Skip all ads — $20';
		skipAllCashBtn.addEventListener('click', () => {
			setSkipAll(true);
			hideOverlay(true);
		});
		// Points button
		skipAllPointsBtn = document.createElement('button');
		skipAllPointsBtn.type = 'button';
		skipAllPointsBtn.className = 'ad-action-btn ad-action-points';
		skipAllPointsBtn.textContent = 'Skip all ads — 2000 Breeze Points';
		skipAllPointsBtn.addEventListener('click', () => {
			setSkipAll(true);
			hideOverlay(true);
		});
		actionsEl.appendChild(skipAllCashBtn);
		actionsEl.appendChild(skipAllPointsBtn);

		skipBtnEl = document.createElement('button');
		skipBtnEl.className = 'ad-skip';
		skipBtnEl.type = 'button';
		skipBtnEl.textContent = 'Skip ad';
		skipBtnEl.disabled = true;
		skipBtnEl.addEventListener('click', () => {
			if (!allowClose) return;
			hideOverlay(true);
		});

		cardEl.appendChild(mediaEl);
		cardEl.appendChild(metaEl);
		cardEl.appendChild(actionsEl);
		cardEl.appendChild(skipBtnEl);
		overlayEl.appendChild(cardEl);
		document.body.appendChild(overlayEl);
	}
	function pickCreative() {
		const idx = Math.floor(Math.random() * creatives.length);
		return creatives[idx];
	}
	function showOverlay(creative) {
		if (getSkipAll()) return;
		ensureOverlay();
		allowClose = false;
		skipBtnEl.disabled = true;
		const img = mediaEl.querySelector('img');
		img.src = creative.imageUrl;
		mediaEl.href = creative.clickUrl || '#';
		metaEl.textContent = creative.brand ? `Sponsored — ${creative.brand}` : 'Sponsored';
		cardEl.setAttribute('aria-label', creative.title || 'Sponsored');
		overlayEl.classList.remove('hidden');
		showing = true;
		window.setTimeout(() => {
			allowClose = true;
			skipBtnEl.disabled = false;
		}, HOUSE_SKIP_MS);
		showTimer = window.setTimeout(() => {
			hideOverlay();
		}, HOUSE_MIN_MS);
	}
	function hideOverlay(userSkipped = false) {
		if (showTimer) {
			clearTimeout(showTimer);
			showTimer = null;
		}
		if (!overlayEl) return;
		overlayEl.classList.add('hidden');
		showing = false;
		if (userSkipped) {
			// Let the game know the user actively skipped an ad
			window.dispatchEvent(new CustomEvent('adSkipped'));
		}
	}

	window.AdService = {
		init: initOnce,
		onReveal() {
			if (getSkipAll()) return;
			showOverlay(pickCreative());
		},
		onQuestion() {
			// hideOverlay();
		}
	};

	// Auto-init when script loads
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', initOnce, { once: true });
	} else {
		initOnce();
	}
})();

