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

    chrome.storage.local.get(['searchTerm', 'caseSensitive', 'highlightMatch', 'filterEnabled', 'sortMode'], function(data) {
        if (data.searchTerm) searchTerm.value = data.searchTerm;
        if (data.caseSensitive !== undefined) caseSensitive.checked = data.caseSensitive;
        if (data.highlightMatch !== undefined) highlightMatch.checked = data.highlightMatch;
        if (data.sortMode) sortMode.value = data.sortMode;

        if (data.filterEnabled) {
            status.textContent = 'Exact filter is ON for your last search tab';
        } else {
            status.textContent = 'Filter is off — use Search Amazon or Filter Current Results to turn it on';
        }
    });

    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
        const currentTab = tabs[0];
        if (currentTab && currentTab.url && currentTab.url.includes('amazon.com/s')) {
            filterBtn.style.display = 'block';
        }
    });

    function currentSettings() {
        return {
            searchTerm: searchTerm.value.trim(),
            caseSensitive: caseSensitive.checked,
            highlightMatch: highlightMatch.checked,
            sortMode: sortMode.value
        };
    }

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

        status.textContent = 'Opening Amazon with exact filter...';

        // Background opens the tab and enables the filter, so it still
        // works even though this popup closes as soon as the tab opens.
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

            chrome.runtime.sendMessage({
                action: 'filterCurrentTab',
                tabId: tabs[0].id,
                settings: settings
            }, function(response) {
                if (chrome.runtime.lastError || !response || !response.ok) {
                    status.textContent = 'Could not start filter — try the Reset button below';
                } else {
                    status.textContent = 'Exact filter turned ON for this tab';
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
