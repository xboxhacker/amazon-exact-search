document.addEventListener('DOMContentLoaded', function() {
    const searchTerm = document.getElementById('searchTerm');
    const searchBtn = document.getElementById('searchBtn');
    const filterBtn = document.getElementById('filterBtn');
    const resetBtn = document.getElementById('resetBtn');
    const caseSensitive = document.getElementById('caseSensitive');
    const highlightMatch = document.getElementById('highlightMatch');
    const sortMode = document.getElementById('sortMode');
    const status = document.getElementById('status');
    const spellSuggestion = document.getElementById('spellSuggestion');
    const versionLabel = document.getElementById('versionLabel');
    const siteButtons = Array.from(document.querySelectorAll('.site-toggle-btn'));

    let targetSite = 'amazon';
    let aliexpressHost = 'www.aliexpress.com';

    versionLabel.textContent = `v${chrome.runtime.getManifest().version}`;

    function siteLabel(site) {
        return site === 'aliexpress' ? 'AliExpress' : 'Amazon';
    }

    function applySiteUi() {
        document.body.classList.toggle('site-aliexpress', targetSite === 'aliexpress');
        siteButtons.forEach(button => {
            button.classList.toggle('site-toggle-btn-active', button.dataset.site === targetSite);
        });
        searchBtn.textContent = `Search ${siteLabel(targetSite)}`;
    }

    function currentSettings() {
        return {
            searchTerm: searchTerm.value.trim(),
            caseSensitive: caseSensitive.checked,
            highlightMatch: highlightMatch.checked,
            sortMode: sortMode.value,
            targetSite,
            aliexpressHost
        };
    }

    function detectSiteFromUrl(url) {
        try {
            const parsed = new URL(url);
            if (/(^|\.)aliexpress\.(com|us)$/i.test(parsed.hostname)) {
                return {
                    site: 'aliexpress',
                    host: parsed.hostname.replace(/^www\./, '') === 'aliexpress.us' ?
                        'www.aliexpress.us' : 'www.aliexpress.com',
                    isSearch: /\/w\/wholesale/i.test(parsed.pathname) ||
                        /\/wholesale/i.test(parsed.pathname) ||
                        parsed.searchParams.has('SearchText') ||
                        parsed.searchParams.has('searchText')
                };
            }

            if (/(^|\.)amazon\.com$/i.test(parsed.hostname)) {
                return {
                    site: 'amazon',
                    host: 'www.amazon.com',
                    isSearch: parsed.pathname === '/s' || parsed.pathname.startsWith('/s/')
                };
            }
        } catch (error) {
            // ignore invalid tab URLs
        }

        return null;
    }

    function setTargetSite(site, persist) {
        targetSite = site === 'aliexpress' ? 'aliexpress' : 'amazon';
        applySiteUi();
        if (persist !== false) {
            chrome.storage.local.set({ targetSite, aliexpressHost });
        }
    }

    chrome.storage.local.get(
        ['searchTerm', 'caseSensitive', 'highlightMatch', 'filterEnabled', 'sortMode', 'targetSite', 'aliexpressHost'],
        function(data) {
            if (data.searchTerm) searchTerm.value = data.searchTerm;
            if (data.caseSensitive !== undefined) caseSensitive.checked = data.caseSensitive;
            if (data.highlightMatch !== undefined) highlightMatch.checked = data.highlightMatch;
            if (data.sortMode) sortMode.value = data.sortMode;
            if (data.aliexpressHost) aliexpressHost = data.aliexpressHost;
            if (data.targetSite) targetSite = data.targetSite;
            applySiteUi();

            if (data.filterEnabled) {
                status.textContent = `Exact filter is ON for your last ${siteLabel(data.targetSite || 'amazon')} search tab`;
            } else {
                status.textContent = 'Filter is off — use Search or Filter Current Results to turn it on';
            }
        }
    );

    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
        const currentTab = tabs[0];
        const detected = currentTab && currentTab.url ? detectSiteFromUrl(currentTab.url) : null;

        if (detected) {
            if (detected.site === 'aliexpress') {
                aliexpressHost = detected.host;
            }
            setTargetSite(detected.site, true);
            if (detected.isSearch) {
                filterBtn.style.display = 'block';
            }
        }
    });

    siteButtons.forEach(button => {
        button.addEventListener('click', function() {
            setTargetSite(button.dataset.site, true);
        });
    });

    searchTerm.addEventListener('input', function() {
        const term = searchTerm.value.trim();
        if (term.length > 2) {
            checkSpelling(term);
        } else {
            spellSuggestion.textContent = '';
        }

        chrome.storage.local.set({searchTerm: term});
    });

    caseSensitive.addEventListener('change', function() {
        chrome.storage.local.set({caseSensitive: caseSensitive.checked});
    });

    highlightMatch.addEventListener('change', function() {
        chrome.storage.local.set({highlightMatch: highlightMatch.checked});
    });

    sortMode.addEventListener('change', function() {
        chrome.storage.local.set({sortMode: sortMode.value});
    });

    searchBtn.addEventListener('click', function() {
        const settings = currentSettings();
        if (!settings.searchTerm) {
            status.textContent = 'Please enter a search term';
            return;
        }

        status.textContent = `Opening ${siteLabel(settings.targetSite)} with exact filter...`;
        chrome.runtime.sendMessage({ action: 'searchAndFilter', settings });
    });

    filterBtn.addEventListener('click', function() {
        const settings = currentSettings();
        if (!settings.searchTerm) {
            status.textContent = 'Please enter a search term to filter by';
            return;
        }

        chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
            if (!tabs[0]) {
                status.textContent = 'No active tab found';
                return;
            }

            const detected = detectSiteFromUrl(tabs[0].url || '');
            if (detected) {
                settings.targetSite = detected.site;
                if (detected.site === 'aliexpress') {
                    settings.aliexpressHost = detected.host;
                    aliexpressHost = detected.host;
                }
                setTargetSite(detected.site, true);
            }

            chrome.runtime.sendMessage({
                action: 'filterCurrentTab',
                tabId: tabs[0].id,
                settings: settings
            }, function(response) {
                if (chrome.runtime.lastError || !response || !response.ok) {
                    status.textContent = 'Could not start filter — try the Reset button below';
                } else {
                    status.textContent = `Exact filter turned ON for this ${siteLabel(settings.targetSite)} tab`;
                }
            });
        });
    });

    resetBtn.addEventListener('click', function() {
        chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
            chrome.runtime.sendMessage({
                action: 'resetAndReload',
                tabId: tabs[0] ? tabs[0].id : null
            }, function() {
                status.textContent = 'Filter cleared — tab reloading with cache bypassed';
            });
        });
    });

    function checkSpelling(term) {
        const commonTerms = [
            'screw', 'bolt', 'nut', 'washer', 'hex', 'socket',
            'button', 'cap', 'stainless', 'steel', 'metric',
            'thread', 'pitch', 'allen', 'torx', 'phillips',
            'm3', 'm4', 'm5', 'm6', 'm8', 'm10', 'm12'
        ];

        const words = term.toLowerCase().split(/\s+/);
        const suggestions = [];

        words.forEach(word => {
            if (!commonTerms.includes(word) && word.length > 2) {
                let bestMatch = null;
                let bestDistance = Infinity;

                commonTerms.forEach(commonTerm => {
                    const distance = levenshteinDistance(word, commonTerm);
                    if (distance < 3 && distance < bestDistance) {
                        bestDistance = distance;
                        bestMatch = commonTerm;
                    }
                });

                if (bestMatch && bestMatch !== word) {
                    suggestions.push(`'${word}' → '${bestMatch}'`);
                }
            }
        });

        if (suggestions.length > 0) {
            spellSuggestion.textContent = '⚠ ' + suggestions.join(', ');
        } else {
            spellSuggestion.textContent = '';
        }
    }

    function levenshteinDistance(a, b) {
        const matrix = [];

        for (let i = 0; i <= b.length; i++) {
            matrix[i] = [i];
        }

        for (let j = 0; j <= a.length; j++) {
            matrix[0][j] = j;
        }

        for (let i = 1; i <= b.length; i++) {
            for (let j = 1; j <= a.length; j++) {
                if (b.charAt(i - 1) === a.charAt(j - 1)) {
                    matrix[i][j] = matrix[i - 1][j - 1];
                } else {
                    matrix[i][j] = Math.min(
                        matrix[i - 1][j - 1] + 1,
                        matrix[i][j - 1] + 1,
                        matrix[i - 1][j] + 1
                    );
                }
            }
        }

        return matrix[b.length][a.length];
    }
});
