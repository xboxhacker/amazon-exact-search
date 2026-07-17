# Amazon Exact Title Search

A Chrome extension that filters Amazon search results so you only see listings whose **titles** actually match what you searched for.

Amazon often shows unrelated items in search results (for example, searching for **M6** screws and getting **M4** or **M5** listings). This extension hides those mismatches and helps you find the right part faster.

**Version:** 1.5.1 · **Manifest:** V3 · **Site:** [amazon.com](https://www.amazon.com) search pages

---

## Features

- **Exact title filtering** — every required search word must appear in the product title
- **Strict hardware sizing** — `M6` does not match `M4`, `M5`, or `M60`
- **Quoted phrases** — `"4mm OD"` must appear together in the title, not as separate words
- **Exclusions** — prefix with `-` to hide titles containing a term (e.g. `-4mm`, `-M4`)
- **Optional sorting** — lowest price, or fastest delivery then lowest price
- **Normal mode** — filter only, keep Amazon’s original result order
- **Hidden results viewer** — click the hidden count to review filtered-out listings in a popup
- **Off by default** — filtering only runs when you click **Search Amazon** or **Filter Current Results**
- **Auto-ends session** when you leave search results (cart, product page) or run a new Amazon search
- **X button** on the filter banner to end the exact-search session immediately

---

## Install (developer / unpacked)

1. Clone or download this repository
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked**
5. Select the `amazon-exact-search` folder
6. Pin the extension from the toolbar if you like

After updates, click **Reload** on the extension card at `chrome://extensions`.

---

## Usage

### Search from the extension

1. Click the extension icon
2. Enter your search terms (see syntax below)
3. Choose sort mode and options
4. Click **Search Amazon**

A new tab opens with Amazon results filtered to exact title matches.

### Filter an existing Amazon search page

1. Run a search on Amazon normally
2. Open the extension popup
3. Enter the terms you want to match in titles
4. Click **Filter Current Results**

### Turn filtering off

- On Amazon, click **Show All Results (Remove Filter)** in the filter banner, or
- Use **Reset Filter + Hard Refresh** in the popup

---

## Search syntax

| Syntax | Meaning | Example |
|--------|---------|---------|
| `word` | Title must contain this word | `screw` |
| `"phrase"` | Exact phrase must appear in the title | `"4mm OD"` |
| `-word` | Title must **not** contain this word | `-4mm` |
| `-"phrase"` | Title must **not** contain this exact phrase | `-"button head"` |

### Examples

```
M6 screw
```
Title must contain **M6** and **screw**.

```
M6 screw -4mm -M4
```
Title must contain **M6** and **screw**, and must **not** contain **4mm** or **M4**.

```
M6 "button head" screw -stainless
```
Title must contain **M6**, the exact phrase **button head**, and **screw**. Titles with **stainless** are hidden.

### Matching rules

- **Metric sizes** (`M3`, `M6`, `M10`) use strict boundaries — `M6` will not match `M60`
- **Plurals** — searching `screw` also matches `screws`
- **Whole words** — `screw` does not match `screwdriver`
- **Case** — matching is case-insensitive unless **Case Sensitive** is checked

---

## Sort options

| Mode | Behavior |
|------|----------|
| **Normal** | Filter only; keep Amazon’s order |
| **Lowest price** | Cheapest matches first |
| **Fastest ship · cheapest** | Soonest delivery first; ties broken by price |

---

## Popup options

| Option | Description |
|--------|-------------|
| **Case Sensitive** | Match exact letter casing |
| **Highlight Match** | Yellow highlight on matched terms in titles |
| **Reset Filter + Hard Refresh** | Clears filter state and reloads the tab bypassing cache |

---

## Project structure

```
amazon-exact-search/
├── manifest.json       # Extension manifest (MV3)
├── background.js       # Tab messaging, script injection, filter state
├── content.js          # Amazon page filtering, sorting, UI banner
├── styles.css          # Injected styles on Amazon (banner, highlights, modal)
├── popup.html          # Extension popup UI
├── popup.js            # Popup logic
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## Permissions

| Permission | Why |
|------------|-----|
| `storage` | Save search terms, sort mode, and filter state |
| `tabs` | Open search tabs and communicate with Amazon pages |
| `scripting` | Inject the filter when the content script is not ready yet |
| `activeTab` | Filter the current Amazon tab on demand |
| `amazon.com` | Run only on Amazon search and product pages |

No data is sent to external servers. Hidden results are kept in memory on the current page only.

---

## Troubleshooting

**Nothing happens after searching**

1. Reload the extension at `chrome://extensions`
2. Close old Amazon tabs and open a fresh search
3. Use **Reset Filter + Hard Refresh** in the popup
4. Make sure you clicked **Search Amazon** or **Filter Current Results** (filter is off until you do)

**0 matches**

The filter is working, but no titles matched all required terms. Try a simpler query like `M6 screw`, or check exclusions (`-word`) are not too aggressive.

**Extension was working, then stopped**

Reload the extension and hard-refresh the Amazon tab. Chrome sometimes keeps an old copy of the content script after updates.

---

## Limitations

- Only filters listings visible on the current Amazon search page (pagination and scroll load more; the extension re-filters as new results appear)
- Title text is read from Amazon’s search result cards; unusual layouts may not parse correctly
- Amazon.com only (not other Amazon marketplaces yet)

---

## License

No license file is included yet. Add one before publishing or redistributing if you plan to open-source this project.

---

## Contributing

Issues and pull requests are welcome. When reporting bugs, include:

- Chrome version
- Extension version
- Search query used
- Whether you used **Search Amazon** or **Filter Current Results**
- A screenshot of the filter banner (match / hidden counts) if possible
