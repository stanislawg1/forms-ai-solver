// ==UserScript==
// @name         Forms Auto Solver (Gemini)
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Read questions from MS Forms and Google Forms, send to Google Gemini, show subtle answers. Defensive parsing + cache + queue + debug.
// @match        https://forms.office.com/*
// @match        https://forms.cloud.microsoft/*
// @match        https://docs.google.com/forms/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_listValues
// @grant        GM_deleteValue
// @connect      generativelanguage.googleapis.com
// ==/UserScript==

(function () {
  "use strict";

  /******************* CONFIG *******************/
  const GEMINI_API_KEY = ""; // <- place your key here
  const MODEL = "gemini-2.0-flash";
  const DEBUG = true;
  const THROTTLE_MS = 700;
  const RETRIES = 2;
  const CACHE_PREFIX = "fas_gemini_v2_cache_";
  const PROCESS_FLAG = "data-fas-processed";
  /**********************************************/

  if (!GEMINI_API_KEY) {
    console.warn("[FAS] Please set GEMINI_API_KEY at top of the script.");
    alert("FAS Script: Please edit the script and add your Google Gemini API Key.");
  }

  function log(...a) {
    if (DEBUG) console.log("[FAS]", ...a);
  }

  GM_addStyle(`
    .fas-suggestion {
      opacity: 0.15 !important;
      font-size: 10px !important;
      color: #333 !important;
      margin-top: 3px !important;
      padding-left: 0 !important;
      user-select: all !important; 
      pointer-events: none !important;
      width: fit-content;
      transition: opacity 0.3s; 
      border-top: 1px dashed #ccc4;
    }
    .fas-suggestion:hover {
        opacity: 0.6 !important;
    }
    .fas-note {
      font-size: 9px !important;
      opacity: 0.1 !important;
      color: #555 !important;
      margin-top: 1px !important;
      pointer-events: none !important;
    }
  `);

  const host = window.location.host;
  let isMSForms = false;
  let isGoogleForms = false;

  if (host.includes("forms.office.com") || host.includes("forms.cloud.microsoft")) isMSForms = true;
  if (host.includes("docs.google.com")) isGoogleForms = true;

  if (!isMSForms && !isGoogleForms) {
    log("Host not supported:", host);
    return;
  }

  log("Detected host:", host, "MSForms?", isMSForms, "GoogleForms?", isGoogleForms);

  function normalizeKey(q, opts) {
    const key = (q || "").trim().replace(/\s+/g, " ").toLowerCase();
    const o = (opts || []).map(x => (x||"").trim().replace(/\s+/g, " ").toLowerCase()).join("||");
    return CACHE_PREFIX + btoa(unescape(encodeURIComponent(key + "||" + o)));
  }

  function elText(el) {
    if (!el) return "";
    return (el.innerText || el.textContent || "").trim();
  }

  function extractOptions(questionEl) {
    const found = new Set();
    const rootContainer = questionEl.closest('[data-automation-id="questionItem"], [role="listitem"], [role="group"]');

    if (!rootContainer) {
        log("extractOptions: Root container not found for question element.");
        return [];
    }
    try {
      const ariaNodes = questionEl.closest('[data-automation-id="questionItem"], [role="listitem"]').querySelectorAll("[aria-label]");
      ariaNodes.forEach(n => {
        const a = n.getAttribute("aria-label");
        if (a) found.add(a.trim());
      });

      const inputs = questionEl.closest('[data-automation-id="questionItem"], [role="listitem"]').querySelectorAll("input[type='radio'], input[type='checkbox']");
      inputs.forEach(inp => {
        let label = null;
        if (inp.id) {
          const lab = questionEl.closest('[data-automation-id="questionItem"], [role="listitem"]').querySelector(`label[for='${CSS.escape(inp.id)}']`);
          if (lab) label = elText(lab);
        }
        if (!label) {
          const p = inp.parentElement;
          if (p) {
            const candidate = p.querySelector("label, span, div");
            if (candidate) label = elText(candidate);
          }
        }
        if (label) found.add(label);
      });

      const googleLabels = questionEl.closest('[role="listitem"]').querySelectorAll(".docssharedWizToggleLabeledLabelText, .W6eOGe, .M7eMe, .Qr7Oae .M7eMe");
      googleLabels.forEach(n => found.add(elText(n)));

      const clickable = questionEl.closest('[role="listitem"]').querySelectorAll("div[role='radio'], div[role='checkbox'], .freebirdFormviewerViewItemsItemItem");
      clickable.forEach(n => {
        const t = elText(n);
        if (t && t.length < 200) found.add(t);
      });

    } catch (e) {
      log("extractOptions error:", e);
    }

    const arr = Array.from(found).map(s => s.trim()).filter(s => s.length > 0);
    return arr;
  }

  /***************** GEMINI RESPONSE PARSING (DEFENSIVE) *****************/
  function parseGeminiResponseText(rawTextOrJson) {
    try {
      let json = null;
      if (typeof rawTextOrJson === "string") {
        try { json = JSON.parse(rawTextOrJson); } catch (e) { json = null; }
      } else if (typeof rawTextOrJson === "object" && rawTextOrJson !== null) {
        json = rawTextOrJson;
      }

      if (json) {
        if (json.candidates && Array.isArray(json.candidates) && json.candidates.length > 0) {
          const c = json.candidates[0];
          if (c.content && c.content.parts && Array.isArray(c.content.parts)) {
             return c.content.parts.map(p => p.text).join(" ").trim();
          }
        }

        if (json.error) {
            log("Gemini API returned error object:", json.error);
            return null;
        }
      }

      if (typeof rawTextOrJson === "string" && !rawTextOrJson.startsWith("<")) {
          return rawTextOrJson.trim();
      }

    } catch (e) {
      log("parseGeminiResponseText error:", e);
    }
    return null; // couldn't parse
  }

  const queue = [];
  let processing = false;

  function enqueueRequest(questionKey, payloadFunc, callback) {
    queue.push({ questionKey, payloadFunc, callback, attempts: 0 });
    processQueue();
  }

  function processQueue() {
    if (processing) return;
    if (queue.length === 0) return;
    processing = true;

    const item = queue.shift();
    const attemptAndSend = () => {
      item.attempts++;
      const payload = item.payloadFunc();

      // Construct URL for Gemini
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`;

      log(`Queue: sending (${item.attempts})`, item.questionKey);

      GM_xmlhttpRequest({
        method: "POST",
        url: url,
        headers: {
          "Content-Type": "application/json"
        },
        data: JSON.stringify(payload),
        timeout: 20000,
        onload: function (res) {
          log("API raw response status:", res.status);
          if (res.status >= 200 && res.status < 300 && res.responseText) {
            const parsed = parseGeminiResponseText(res.responseText);
            if (parsed !== null) {
              item.callback(null, parsed);
              setTimeout(() => { processing = false; processQueue(); }, THROTTLE_MS);
              return;
            } else {
              log("Parse failed but status ok.");
              item.callback(new Error("Failed to parse Gemini response"));
              setTimeout(() => { processing = false; processQueue(); }, THROTTLE_MS);
              return;
            }
          } else {
            log("API status non-2xx:", res.status, res.responseText);
            // Transient errors: 429 (Too Many Requests), 5xx
            if ([429, 500, 502, 503, 504].includes(res.status) && item.attempts <= RETRIES) {
              const backoff = 1500 * item.attempts;
              log(`Transient error ${res.status}, retry after ${backoff}ms`);
              setTimeout(attemptAndSend, backoff);
              return;
            }
            item.callback(new Error(`Gemini error: status ${res.status}`));
            setTimeout(() => { processing = false; processQueue(); }, THROTTLE_MS);
            return;
          }
        },
        onerror: function (err) {
          log("GM_xmlhttpRequest error:", err);
          if (item.attempts <= RETRIES) {
            setTimeout(attemptAndSend, 2000 * item.attempts);
            return;
          }
          item.callback(new Error("Network request failed"));
          setTimeout(() => { processing = false; processQueue(); }, THROTTLE_MS);
        },
        ontimeout: function () {
          if (item.attempts <= RETRIES) {
            setTimeout(attemptAndSend, 2000 * item.attempts);
            return;
          }
          item.callback(new Error("Request timed out"));
          setTimeout(() => { processing = false; processQueue(); }, THROTTLE_MS);
        }
      });
    };

    attemptAndSend();
  }

async function processQuestionElement(qEl) {
    try {
        const containerEl = qEl.closest(
            '[data-automation-id="questionItem"], [role="listitem"], [role="group"], .question-container, .question-root'
        );
        if (!containerEl) {
          return;
        }
        if (containerEl.getAttribute(PROCESS_FLAG) === "true") {
          return;
        }
        if (containerEl.querySelector(".fas-suggestion")) {
          containerEl.setAttribute(PROCESS_FLAG, "true");
          return;
        }
        if (containerEl.getAttribute(PROCESS_FLAG) === "processing") {
            return;
        }


        containerEl.setAttribute(PROCESS_FLAG, "processing");

        const questionText = elText(qEl);
        const options = extractOptions(qEl);

      if (!questionText || questionText.length < 3) {
          containerEl.removeAttribute(PROCESS_FLAG);
          return;
      }

      log("Question detected:", questionText, "Options found:", options.length);

      const cacheKey = normalizeKey(questionText, options);
      const cached = GM_getValue(cacheKey, null);
      if (cached) {
        log("Cache hit:", cached);
        insertAnswer(containerEl, cached);
        containerEl.setAttribute(PROCESS_FLAG, "true");
        return;
      }

      let systemInstruction = "You are a helpful quiz assistant. Answer succinctly. You MUST only respond with the answer text, no conversational text.";
      let userPrompt = "";

      if (options && options.length > 0) {
        userPrompt =
          "QUESTION:\n" + questionText + "\n\n" +
          "OPTIONS:\n" + options.map((o, i) => `${i + 1}. ${o}`).join("\n") + "\n\n" +
          "INSTRUCTION: Select the best option from the list above. Return ONLY the exact text of the correct option. " +
          "If multiple are correct, separate with commas. If uncertain, append a short 'Note:' at the end.";
      } else {
        userPrompt =
          "QUESTION:\n" + questionText + "\n\n" +
          "INSTRUCTION: This is an open question. Provide a short, factual answer. If uncertain, add a 'Note:' sentence.";
      }

      const fullPrompt = `${systemInstruction}\n\n${userPrompt}`;

      enqueueRequest(cacheKey, () => {
        return {
          contents: [{
            parts: [{
              text: fullPrompt
            }]
          }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 160
          }
        };
      }, (err, resultText) => {
        if (err) {
          log("Gemini callback error:", err);
          containerEl.removeAttribute(PROCESS_FLAG);
          return;
        }
        const answerText = (typeof resultText === "string" ? resultText : String(resultText)).trim();
        GM_setValue(cacheKey, answerText);
        insertAnswer(containerEl, answerText);
        containerEl.setAttribute(PROCESS_FLAG, "true");
        log("Inserted answer for question:", questionText);
      });

    } catch (ex) {
      log("processQuestionElement exception:", ex);
      if (qEl.closest('[data-automation-id="questionItem"], [role="listitem"], [role="group"]')) {
        qEl.closest('[data-automation-id="questionItem"], [role="listitem"], [role="group"]').removeAttribute(PROCESS_FLAG);
      }
    }
  }

  function insertAnswer(containerEl, answerRaw) {
    try {
      if (!containerEl || !answerRaw) return;
      if (containerEl.querySelector(".fas-suggestion")) return;

      let main = answerRaw;
      let note = null;
      const noteIndex = answerRaw.indexOf("Note:");
      if (noteIndex >= 0) {
        main = answerRaw.slice(0, noteIndex).trim();
        note = answerRaw.slice(noteIndex).trim();
      }

      main = main.replace(/\*\*/g, "").replace(/^Suggestion:\s*/i, "");

      const wrap = document.createElement("div");
      wrap.className = "fas-suggestion";

      const mainEl = document.createElement("div");
      mainEl.textContent = `R: ${main}`;
      wrap.appendChild(mainEl);

      if (note) {
        const noteEl = document.createElement("div");
        noteEl.className = "fas-note";
        noteEl.textContent = note;
        wrap.appendChild(noteEl);
      }

      containerEl.appendChild(wrap);

    } catch (e) {
      log("insertAnswer error:", e);
    }
  }

  function scanAndProcess() {
    try {
      let questionEls = [];

      if (isMSForms) {
        const questionContainers = Array.from(document.querySelectorAll('[data-automation-id="questionItem"]'));

        questionContainers.forEach(container => {
          const questionTextEl = container.querySelector('[data-automation-id="questionTitle"] .text-format-content');
          if (questionTextEl) {
             questionEls.push(questionTextEl);
          }
        });

      } else if (isGoogleForms) {
        const candidates = Array.from(document.querySelectorAll("div[role='listitem'], div[role='group']"));
        candidates.forEach(container => {
          const qText = container.querySelector(".M7eMe, .freebirdFormviewerViewItemsItemItemTitle, .freebirdFormviewerViewItemsItemItemTitleDesc");
          if (qText) questionEls.push(qText);
        });
      }

      questionEls = Array.from(new Set(questionEls));

      log("scanAndProcess found", questionEls.length, "question elements");

      questionEls.forEach(qEl => {
        processQuestionElement(qEl);
      });
    } catch (e) {
      log("scanAndProcess error:", e);
    }
  }

  const observer = new MutationObserver((mutations) => {
    let added = false;
    for (const m of mutations) {
      if (m.addedNodes && m.addedNodes.length > 0) {
        added = true;
        break;
      }
    }
    if (added) {
      setTimeout(scanAndProcess, 500);
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  setTimeout(() => {
    log("Initial scan start");
    scanAndProcess();
  }, 1500);

  // Debug tool
  window.FAS_Gemini = {
    clearAllCache: () => {
      const keys = GM_listValues();
      keys.forEach(k => {
          if(k.startsWith(CACHE_PREFIX)) GM_deleteValue(k);
      });
      console.log("FAS Gemini Cache Cleared");
    }
  };

  log("FAS Gemini initialized.");
})();