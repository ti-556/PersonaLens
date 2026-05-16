# PersonaLens

A Chrome extension + local Node backend prototype that uses the Gemini API to simplify the **original webpage UI in-place**.

## Project structure

```text
persona-lens-chatgpt/
  extension/
    manifest.json
    popup.html
    popup.css
    popup.js
    content.js
  backend/
    package.json
    .env.example
    server.js
  demo/
    cluttered-gov-page.html
```

## 1. Start the backend

```bash
cd backend
npm install
cp .env.example .env
```

Edit `.env`:

```bash
OPENAI_API_KEY=your_key_here
PORT=3000
```

Run:

```bash
npm run dev
```

The backend should run at:

```text
http://localhost:3000
```

The extension popup calls:

```text
http://localhost:3000/simplify
```

## 2. Load the Chrome extension

1. Open Chrome.
2. Go to `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the `extension/` folder, not the whole project folder.
6. If you test by opening `demo/cluttered-gov-page.html` directly from disk, open the extension details page and enable **Allow access to file URLs**.

## 3. Test on the demo page

Open:

```text
demo/cluttered-gov-page.html
```

Then click the extension icon and press **Simplify current page**.

## How it works

```text
Current webpage
  ↓
content.js extracts visible DOM elements
  ↓
popup.js sends persona + DOM summary to backend
  ↓
server.js calls ChatGPT API
  ↓
AI returns JSON patch actions
  ↓
content.js applies patches to the original page
```

Example AI response:

```json
{
  "explanation": "Highlighted the main certificate application button and made the key instructions easier to read.",
  "actions": [
    {
      "type": "primary",
      "targetId": "pl_123",
      "reason": "This is the main action for applying online.",
      "stepLabel": "Step 1: Start here"
    },
    {
      "type": "increase_readability",
      "targetId": "pl_124",
      "reason": "This instruction helps the user understand the process."
    },
    {
      "type": "dim",
      "targetId": "pl_125",
      "reason": "This content is unrelated to the user's current task."
    }
  ]
}
```

## Supported patch actions

- `primary`: marks the single most important action.
- `emphasize`: highlights useful elements.
- `dim`: de-emphasizes distracting elements without removing them.
- `increase_readability`: increases readability of text.
- `simplify_text`: rewrites short labels/buttons/headings while preserving meaning.
- `add_tooltip`: adds a native browser tooltip.
- `scroll_to`: scrolls to the most relevant element.

## Safety behavior

The backend validator prevents invalid target IDs and protects sensitive content. Warnings, prices, fees, legal notices, privacy notices, security notices, errors, payments, and consent-related content are not dimmed or rewritten. They may only be highlighted or made more readable.

The reset button restores patched styles and text.

## Notes

This is still a hackathon prototype. It does not deeply understand every web app framework. It works best on static pages, public service pages, dashboards, shopping pages, and forms where visible DOM elements are easy to extract.
