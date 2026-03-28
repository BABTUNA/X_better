/**
 * ISOLATED world content script
 * Handles UI injection, search/filter, auto-scroll, and export
 */
(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────
  let collectedUsers = new Map(); // screenName -> user object
  let collectedTweets = new Map(); // tweetId -> tweet object
  let currentUrl = '';
  let currentPageUser = '';
  let currentPageType = ''; // 'followers' | 'following' | 'search'
  let currentSearchQuery = '';
  let toolbar = null;
  let urlPollTimer = null;
  let scrollTimer = null;
  let scrollTimeout = null;
  let isScrolling = false;
  let staleCount = 0;
  let loadLimit = 0; // 0 = unlimited

  function isSearchMode() {
    return currentPageType === 'search';
  }

  function getCollectedCount() {
    return isSearchMode() ? collectedTweets.size : collectedUsers.size;
  }

  // ── URL Detection ──────────────────────────────────────────────────
  function parsePageInfo(url) {
    // Check follower/following pages first
    const followerMatch = url.match(
      /^https:\/\/(x|twitter)\.com\/([^/]+)\/(followers|following|verified_followers)\/?$/
    );
    if (followerMatch) {
      return { user: followerMatch[2], type: followerMatch[3] };
    }

    // Check search pages
    if (XFE.URL_SEARCH.test(url)) {
      try {
        const u = new URL(url);
        const query = u.searchParams.get('q') || '';
        return { type: 'search', query };
      } catch (e) {
        return null;
      }
    }

    return null;
  }

  function startUrlPolling() {
    currentUrl = location.href;
    urlPollTimer = setInterval(() => {
      if (location.href !== currentUrl) {
        currentUrl = location.href;
        onNavigate();
      }
    }, XFE.URL_POLL_INTERVAL);
    onNavigate();
  }

  function onNavigate() {
    const info = parsePageInfo(location.href);
    if (!info) {
      cleanup();
      currentPageUser = '';
      currentPageType = '';
      currentSearchQuery = '';
      return;
    }

    if (info.type === 'search') {
      if (currentPageType !== 'search' || currentSearchQuery !== info.query) {
        cleanup();
        currentPageType = 'search';
        currentSearchQuery = info.query;
        currentPageUser = '';
        collectedTweets = new Map();
        waitForContainer();
      }
    } else {
      if (info.user !== currentPageUser || info.type !== currentPageType) {
        cleanup();
        currentPageUser = info.user;
        currentPageType = info.type;
        currentSearchQuery = '';
        collectedUsers = new Map();
        waitForContainer();
      }
    }
  }

  // ── Wait for DOM container ─────────────────────────────────────────
  function waitForContainer() {
    const existing = document.querySelector(XFE.SEL_PRIMARY_COLUMN);
    if (existing) {
      onContainerReady(existing);
      return;
    }

    const observer = new MutationObserver((_, obs) => {
      const el = document.querySelector(XFE.SEL_PRIMARY_COLUMN);
      if (el) {
        obs.disconnect();
        onContainerReady(el);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function onContainerReady(primaryColumn) {
    const tryInject = () => {
      const region = primaryColumn.querySelector(XFE.SEL_REGION);
      if (region) {
        injectToolbar(region);
        startDomObserver(region);
      } else {
        setTimeout(tryInject, 300);
      }
    };
    tryInject();
  }

  // ── Theme Detection ────────────────────────────────────────────────
  function detectTheme() {
    const bg = getComputedStyle(document.body).backgroundColor;
    const match = bg.match(/\d+/g);
    if (!match) return 'light';
    const [r, g, b] = match.map(Number);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance < 0.5 ? 'dark' : 'light';
  }

  function watchTheme() {
    const observer = new MutationObserver(() => {
      if (toolbar) {
        toolbar.setAttribute('data-xfe-theme', detectTheme());
      }
    });
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['style', 'class'],
    });
  }

  // ── UI Injection ───────────────────────────────────────────────────
  function injectToolbar(region) {
    if (document.querySelector('.xfe-toolbar')) return;

    toolbar = document.createElement('div');
    toolbar.className = 'xfe-toolbar';
    toolbar.setAttribute('data-xfe-theme', detectTheme());

    toolbar.innerHTML = `
      <div class="xfe-search-wrap">
        <svg class="xfe-search-icon" viewBox="0 0 24 24">
          <path d="M10.25 3.75a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zm-8.5 6.5a8.5 8.5 0 1 1 15.176 5.262l4.531 4.53-1.414 1.415-4.531-4.531A8.5 8.5 0 0 1 1.75 10.25z"/>
        </svg>
        <input class="xfe-search-input" type="text" placeholder="Search..." />
        <span class="xfe-badge">0</span>
      </div>
      <div class="xfe-load-group">
        <span class="xfe-load-label">Max:</span>
        <input class="xfe-load-input" type="number" min="1" placeholder="e.g. 500" title="Max users to load (leave empty for all)" />
        <button class="xfe-btn xfe-btn--primary xfe-btn-load">Load All</button>
      </div>
      <button class="xfe-btn xfe-btn-csv">Export CSV</button>
      <button class="xfe-btn xfe-btn-json">Export JSON</button>
      <span class="xfe-offscreen-info"></span>
      <div class="xfe-status"></div>
    `;

    region.parentElement.insertBefore(toolbar, region);

    // Event listeners
    const input = toolbar.querySelector('.xfe-search-input');
    input.addEventListener('input', () => onSearch(input.value));

    const loadInput = toolbar.querySelector('.xfe-load-input');
    loadInput.addEventListener('input', () => {
      const val = parseInt(loadInput.value, 10);
      loadLimit = val > 0 ? val : 0;
      const btn = toolbar.querySelector('.xfe-btn-load');
      if (btn && !isScrolling) {
        btn.textContent = loadLimit > 0 ? `Load ${loadLimit}` : 'Load All';
      }
    });

    toolbar
      .querySelector('.xfe-btn-load')
      .addEventListener('click', toggleAutoScroll);
    toolbar
      .querySelector('.xfe-btn-csv')
      .addEventListener('click', () => exportData('csv'));
    toolbar
      .querySelector('.xfe-btn-json')
      .addEventListener('click', () => exportData('json'));

    watchTheme();
    updateBadge();
  }

  // ── Data Collection via postMessage ────────────────────────────────
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type !== XFE.MSG_USERS_CAPTURED) return;

    const users = event.data.users || [];
    let newCount = 0;
    for (const user of users) {
      // Always key on screenName for consistent dedup
      const key = user.screenName;
      if (!key) continue;
      const existing = collectedUsers.get(key);
      if (!existing) {
        collectedUsers.set(key, user);
        newCount++;
      } else {
        // Merge: prefer non-empty values from the new data (API data is richer)
        for (const [k, v] of Object.entries(user)) {
          if (v !== '' && v !== undefined && v !== null && (existing[k] === '' || existing[k] === undefined)) {
            existing[k] = v;
          }
        }
      }
    }
    if (newCount > 0) {
      updateBadge();
      updateBadgeExtension();
      if (isScrolling && loadLimit > 0 && collectedUsers.size >= loadLimit) {
        stopAutoScroll('Limit reached');
      }
    }
  });

  // ── DOM Scraping Fallback ──────────────────────────────────────────
  function scrapeVisibleCells() {
    const cells = document.querySelectorAll(XFE.SEL_USER_CELL);
    let newCount = 0;
    cells.forEach((cell) => {
      try {
        // Extract screen name from profile links (href="/{screenName}")
        let screenName = '';
        const links = cell.querySelectorAll('a[role="link"]');
        for (const link of links) {
          const href = link.getAttribute('href');
          if (href && /^\/[A-Za-z0-9_]+$/.test(href)) {
            screenName = href.slice(1);
            break;
          }
        }
        if (!screenName) return;

        // If user already exists (e.g. from API interceptor), merge DOM data in
        if (collectedUsers.has(screenName)) {
          const existing = collectedUsers.get(screenName);
          if (name && (!existing.name || existing.name === existing.screenName)) {
            existing.name = name;
          }
          if (description && !existing.description) {
            existing.description = description;
          }
          if (profileImageUrl && !existing.profileImageUrl) {
            existing.profileImageUrl = profileImageUrl;
          }
          if (verified && !existing.verified) {
            existing.verified = verified;
          }
          return;
        }

        // Extract display name: first dir="ltr" span inside the first profile link
        let name = '';
        const firstProfileLink = cell.querySelector(`a[href="/${screenName}"][role="link"]`);
        if (firstProfileLink) {
          const nameSpan = firstProfileLink.querySelector('span span');
          if (nameSpan) {
            name = nameSpan.textContent.trim();
          }
        }

        // Extract description: the last dir="auto" div in the cell (the bio text)
        let description = '';
        const bioDiv = cell.querySelector('div[dir="auto"][class*="css-146c3p1"]:last-of-type');
        if (bioDiv && !bioDiv.querySelector('button') && !bioDiv.id) {
          const text = bioDiv.textContent.trim();
          // Skip if it looks like the hidden "Click to Unfollow" label
          if (text && !text.startsWith('Click to')) {
            description = text;
          }
        }

        // Extract profile image from the avatar container
        let profileImageUrl = '';
        const avatarContainer = cell.querySelector('[data-testid^="UserAvatar-Container"]');
        if (avatarContainer) {
          const img = avatarContainer.querySelector('img');
          if (img) profileImageUrl = img.src;
        }

        // Check for verified badge
        const verified = !!cell.querySelector('[data-testid="icon-verified"]');

        collectedUsers.set(screenName, {
          name: name || screenName,
          screenName,
          description,
          followersCount: '',
          followingCount: '',
          verified,
          profileImageUrl,
          createdAt: '',
        });
        newCount++;
      } catch (e) {
        // Skip malformed cells
      }
    });
    if (newCount > 0) {
      updateBadge();
      updateBadgeExtension();
      if (isScrolling && loadLimit > 0 && collectedUsers.size >= loadLimit) {
        stopAutoScroll('Limit reached');
      }
    }
  }

  function startDomObserver(region) {
    const observer = new MutationObserver(() => {
      scrapeVisibleCells();
    });
    observer.observe(region, { childList: true, subtree: true });
    scrapeVisibleCells();
  }

  // ── Search / Filter ────────────────────────────────────────────────
  function onSearch(query) {
    const q = query.toLowerCase().trim();
    const cells = document.querySelectorAll(XFE.SEL_USER_CELL);

    let visibleMatches = 0;
    cells.forEach((cell) => {
      const text = cell.textContent.toLowerCase();
      if (!q || text.includes(q)) {
        cell.style.display = '';
        visibleMatches++;
      } else {
        cell.style.display = 'none';
      }
    });

    // Count offscreen matches from collected data
    if (q) {
      let totalMatches = 0;
      for (const [, user] of collectedUsers) {
        const searchable = `${user.name} ${user.screenName} ${user.description}`.toLowerCase();
        if (searchable.includes(q)) totalMatches++;
      }
      const offscreen = totalMatches - visibleMatches;
      const info = toolbar?.querySelector('.xfe-offscreen-info');
      if (info && offscreen > 0) {
        info.textContent = `+${offscreen} match${offscreen !== 1 ? 'es' : ''} in collected data (not visible on screen)`;
        info.classList.add('xfe-visible');
      } else if (info) {
        info.classList.remove('xfe-visible');
      }
    } else {
      const info = toolbar?.querySelector('.xfe-offscreen-info');
      if (info) info.classList.remove('xfe-visible');
    }
  }

  // ── Auto-Scroll ────────────────────────────────────────────────────
  function toggleAutoScroll() {
    if (isScrolling) {
      stopAutoScroll();
    } else {
      startAutoScroll();
    }
  }

  function startAutoScroll() {
    isScrolling = true;
    staleCount = 0;
    let lastCount = collectedUsers.size;

    const btn = toolbar?.querySelector('.xfe-btn-load');
    if (btn) {
      btn.textContent = `Loading... (${collectedUsers.size})`;
      btn.classList.add('xfe-btn--primary');
    }

    scrollTimer = setInterval(() => {
      // Smooth scroll instead of jumping to bottom
      window.scrollBy({ top: window.innerHeight * 2, behavior: 'smooth' });
      scrapeVisibleCells();

      const currentCount = collectedUsers.size;
      if (currentCount === lastCount) {
        staleCount++;
      } else {
        staleCount = 0;
        lastCount = currentCount;
      }

      if (btn) btn.textContent = `Loading... (${currentCount})`;

      // Stop if limit reached
      if (loadLimit > 0 && currentCount >= loadLimit) {
        stopAutoScroll('Limit reached');
        return;
      }

      if (staleCount >= XFE.SCROLL_STALE_LIMIT) {
        stopAutoScroll('Complete');
      }
    }, XFE.SCROLL_INTERVAL);

    scrollTimeout = setTimeout(() => {
      stopAutoScroll('Timeout');
    }, XFE.SCROLL_TIMEOUT);
  }

  function stopAutoScroll(reason) {
    isScrolling = false;
    if (scrollTimer) {
      clearInterval(scrollTimer);
      scrollTimer = null;
    }
    if (scrollTimeout) {
      clearTimeout(scrollTimeout);
      scrollTimeout = null;
    }

    const btn = toolbar?.querySelector('.xfe-btn-load');
    if (btn) {
      const label = loadLimit > 0 ? `Load ${loadLimit}` : 'Load All';
      const suffix = reason ? ` (${reason})` : '';
      btn.textContent = `${label}${suffix}`;
      btn.classList.remove('xfe-btn--primary');
      setTimeout(() => {
        if (btn) btn.textContent = label;
      }, 3000);
    }
    updateBadge();
    updateBadgeExtension();
  }

  // ── Badge Updates ──────────────────────────────────────────────────
  function updateBadge() {
    const badge = toolbar?.querySelector('.xfe-badge');
    if (badge) badge.textContent = collectedUsers.size;
  }

  function updateBadgeExtension() {
    try {
      chrome.runtime?.sendMessage({
        type: 'xfe_update_badge',
        count: collectedUsers.size,
      });
    } catch (e) {
      // Extension context may be invalidated
    }
  }

  // ── Export ─────────────────────────────────────────────────────────
  function exportData(format) {
    if (collectedUsers.size === 0) return;

    const users = Array.from(collectedUsers.values());
    const date = new Date().toISOString().split('T')[0];
    const filename = `${currentPageUser}_${currentPageType}_${date}`;

    if (format === 'csv') {
      downloadCsv(users, filename);
    } else {
      downloadJson(users, filename);
    }
  }

  function formatDate(dateStr) {
    if (!dateStr) return '';
    try {
      const d = new Date(dateStr);
      if (isNaN(d)) return dateStr;
      return d.toISOString().split('T')[0];
    } catch (e) {
      return dateStr;
    }
  }

  function downloadCsv(users, filename) {
    const headers = [
      'name',
      'screen_name',
      'description',
      'followers_count',
      'following_count',
      'verified',
      'profile_image_url',
      'created_at',
    ];

    const escapeCsv = (val) => {
      const str = String(val ?? '');
      if (str.includes('"') || str.includes(',') || str.includes('\n')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    };

    const rows = [headers.join(',')];
    for (const u of users) {
      rows.push(
        [
          u.name,
          u.screenName,
          u.description,
          u.followersCount,
          u.followingCount,
          u.verified,
          u.profileImageUrl,
          formatDate(u.createdAt),
        ]
          .map(escapeCsv)
          .join(',')
      );
    }

    download(rows.join('\n'), `${filename}.csv`, 'text/csv');
  }

  function downloadJson(users, filename) {
    const cleaned = users.map(({ id, ...rest }) => ({
      ...rest,
      createdAt: formatDate(rest.createdAt),
    }));
    const json = JSON.stringify(cleaned, null, 2);
    download(json, `${filename}.json`, 'application/json');
  }

  function download(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ── Cleanup ────────────────────────────────────────────────────────
  function cleanup() {
    stopAutoScroll();
    if (toolbar && toolbar.parentElement) {
      toolbar.parentElement.removeChild(toolbar);
    }
    toolbar = null;
  }

  // ── Init ───────────────────────────────────────────────────────────
  startUrlPolling();
})();
