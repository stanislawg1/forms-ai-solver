# forms-ai-solver

## Description

`forms-ai-solver` is a Tampermonkey-compatible userscript that helps detect and assist in filling out online forms created with Microsoft Forms and Google Forms. It can suggest single or multiple-choice answers to given questions.

This repository contains the main userscript source at `script.js`.

## Features

- Detects Microsoft Forms and Google Forms pages.
- Suggests correct answer/answers under the question.
- Tested on Firefox for Android and Firefox/LibreWolf on Linux.

## Form suggestion example results
Examples come from MS Forms.
### Single-choice questions

![image](/img/single-choice.png)

### Multiple-choice questions
![image](/img/multi-choice.png)


## Installation
1. Get Gemini API key
1. Paste your API key in `script.js` 22 line:
```js
  const GEMINI_API_KEY = ""; // <- place your key here
```
3. Install a userscript manager in your browser (Tampermonkey is recommended; Violentmonkey/Greasemonkey are alternatives).
4. Install the script:
   - 4.1 Open the Tampermonkey dashboard 
   - 4.2 Click on "Create a new script"
   - 4.3 Copy the contents of `script.js` into the editor and save.
5. Ensure the script is enabled and that Tampermonkey is allowed to run on the form domains you plan to use:
    - `https://forms.office.com/*`
    - `https://forms.cloud.microsoft/*` 
    - `https://docs.google.com/forms`.

### Installation expected results:

When you enter one of the metioned earlier sites on your extensions pane you should see, that TamperMonkey script works:

![image](/img/enabled.png)

also, when you click there, you should see that your script is enabled:

![image](/img/enabled_script.png)

## Usage

1. Open a Microsoft Forms or Google Forms URL in a browser where the userscript is installed and enabled.
2. The script will detect the form if it matches supported patterns and will try to present suggestions.
3. Review suggested answers AI can make mistakes.

## Tested environments

- Firefox on Android - tested and works.
- LibreWolf on Linux - tested and works.

Other Chromium-based browsers may work but are not guaranteed.