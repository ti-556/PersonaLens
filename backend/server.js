import "dotenv/config";
import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "persona-lens-backend" });
});

app.post("/simplify", async (req, res) => {
  try {
    const { persona, domSummary } = req.body || {};

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY in backend/.env" });
    }

    if (!persona || !domSummary?.elements) {
      return res.status(400).json({ error: "Expected persona and domSummary.elements." });
    }

    const compactDom = {
      url: domSummary.url,
      title: domSummary.title,
      viewport: domSummary.viewport,
      elements: domSummary.elements.slice(0, 300).map((el) => ({
        id: el.id,
        kind: el.kind,
        tag: el.tag,
        role: el.role,
        text: el.text,
        ariaLabel: el.ariaLabel,
        placeholder: el.placeholder,
        isClickable: el.isClickable,
        area: el.area,
        intent: el.intent,
        context: el.context,
        rect: el.rect
      }))
    };

    const personaStrategy = inferPersonaStrategy(persona);
    const prompt = buildPrompt({ persona, domSummary: compactDom, personaStrategy });

    const response = await client.responses.create({
      model: "gpt-5.5",
      input: prompt
    });

    const rawText = response.output_text || "";
    const parsed = parseJsonFromModel(rawText);
    const safe = validateAndNormalize(parsed, compactDom, personaStrategy);

    res.json(safe);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "OpenAI request failed." });
  }
});

function buildPrompt({ persona, domSummary, personaStrategy }) {
  return `
You are controlling a Chrome extension that modifies the ORIGINAL webpage in-place.

Important: Do NOT regenerate a new page. Do NOT output HTML or CSS. Do NOT create new UI elements. You may only modify, move, resize, rewrite, or hide/delete existing elements by targetId.

Your job is to output a safe reconstruction plan that makes the original page feel like a much simpler website using the same underlying elements.
There is no user-entered goal. Infer the page's most likely task from the title, headings, central content, clickable controls, area, intent, and element positions.

USER PERSONA:
${persona}

PERSONA-ADAPTIVE STRATEGY:
${JSON.stringify({
  profile: personaStrategy.profile,
  informationDensity: personaStrategy.informationDensity,
  targetElementRange: `${personaStrategy.targetMinElements}-${personaStrategy.targetMaxElements}`,
  maxElementCount: personaStrategy.maxElements,
  visualStyle: personaStrategy.visualStyle,
  instructions: personaStrategy.instructions
}, null, 2)}

CURRENT PAGE SUMMARY:
${JSON.stringify(domSummary, null, 2)}

OUTPUT REQUIREMENTS:
Return only valid JSON with this exact shape:
{
  "explanation": "short string explaining what changed",
  "mode": "reconstruct",
  "presentation": {
    "density": "minimal | balanced | rich",
    "baseFontSize": 14 to 22,
    "contentWidth": 620 to 1120,
    "itemGap": 8 to 30,
    "paddingX": 16 to 40,
    "paddingY": 24 to 56
  },
  "elements": [
    {
      "targetId": "one of the provided element ids",
      "purpose": "heading | text | field | primary_action | action | notice | support",
      "reason": "short reason for keeping this element",
      "newText": "optional simpler text for short labels/headings/buttons",
      "visual": "optional object with bounded visual values"
    }
  ]
}

RECONSTRUCTION MEANING:
- Select the original elements that should appear in the simplified website, including needed headings, text, form fields, controls, notices, and supporting links.
- Order them as a clean simple page: main heading, short key instruction, fields/content, main action, required notices, useful secondary actions.
- Omit clutter by not selecting it.
- You are not creating new content. You are choosing and optionally simplifying existing elements.

VISUAL OBJECT:
{
  "fontScale": 0.85 to 1.7,
  "lineHeight": 1.2 to 1.9,
  "maxWidth": 240 to 1000,
  "widthMode": "comfortable | full",
  "align": "left | center"
}

QUALITY BAR:
- Make a coherent, large transformation: the page should feel like a simplified version of the website, not a guided overlay.
- The persona must materially change the result. Use the PERSONA-ADAPTIVE STRATEGY, especially targetElementRange, informationDensity, and visualStyle.
- Keep only the elements needed for a simplified website. Most nav/sidebar/ad/duplicate elements should be omitted.
- Preserve required notices and safety/legal/payment/security information by selecting them when present.
- Use only existing source elements. Do not invent new headings, claims, instructions, prices, dates, or controls.
- Select roughly the PERSONA-ADAPTIVE STRATEGY targetElementRange when the page has enough useful content.
- Simplify short labels and headings when they are formal, long, or confusing.
- Use the element context and position to understand sections such as main content, sidebars, nav, ads, and notices.
- Prefer central main/form/article content over header/nav/aside elements.
- For elderly, low-vision, low-literacy, or confused users: keep very few elements, use larger visual values, and focus on one clear path.
- For high schoolers, students, or curious learners: keep more explanatory context, useful links, and supporting information while still removing clutter.

SAFETY RULES:
- Never omit warnings, prices, fees, legal notices, privacy notices, security notices, error messages, payment information, or consent controls.
- Never modify actual form values.
- Never invent official content, prices, dates, or claims.
- Return an element count matching the PERSONA-ADAPTIVE STRATEGY when the page has enough visible elements.
- Only use targetIds that exist in CURRENT PAGE SUMMARY.
- For newText, only rewrite short labels/headings/buttons, not long official paragraphs.
- For images/graphics/visual elements, select them only if they are task-relevant.

Return JSON only. No markdown fences.
`;
}

function parseJsonFromModel(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Model did not return JSON.");
    return JSON.parse(match[0]);
  }
}

function inferPersonaStrategy(persona) {
  const text = String(persona || "").toLowerCase();
  const mentionsElderly =
    /\b(elderly|senior|older adult|older user|aged|aging|low vision|weak vision|poor vision|large text|low literacy|low digital|digital literacy|confused|confusing|memory|cognitive|dementia|novice|beginner)\b/.test(text);
  const mentionsStudent =
    /\b(high\s*school|highschool|teen|teenager|student|learner|class|homework|youth|young adult)\b/.test(text);
  const mentionsExpert =
    /\b(expert|professional|power user|analyst|developer|admin|operator|researcher|advanced)\b/.test(text);

  if (mentionsElderly) {
    return {
      profile: "elderly_accessible",
      informationDensity: "very low",
      targetMinElements: 5,
      targetMaxElements: 10,
      maxElements: 12,
      maxRawItems: 16,
      readableLimit: 4,
      fieldLimit: 7,
      actionLimit: 2,
      protectedLimit: 6,
      simplifyLimit: 10,
      visualStyle: "large text, roomy spacing, one-column, one main path",
      presentation: {
        density: "minimal",
        baseFontSize: 20,
        contentWidth: 760,
        itemGap: 24,
        paddingX: 30,
        paddingY: 44
      },
      visual: {
        headingScale: 1.55,
        textScale: 1.28,
        fieldScale: 1.18,
        actionScale: 1.42,
        noticeScale: 1.18,
        lineHeight: 1.75,
        textMaxWidth: 660,
        fieldMaxWidth: 640,
        actionMaxWidth: 600
      },
      instructions: [
        "Use the most drastic simplification.",
        "Keep the main task, required fields, the main action, and required/safety notices.",
        "Omit optional explanation, duplicate links, broad navigation, and secondary actions unless needed for completion.",
        "Prefer larger text, larger controls, short labels, and a single clear path."
      ]
    };
  }

  if (mentionsStudent) {
    return {
      profile: "student_contextual",
      informationDensity: "medium high",
      targetMinElements: 14,
      targetMaxElements: 24,
      maxElements: 28,
      maxRawItems: 34,
      readableLimit: 11,
      fieldLimit: 10,
      actionLimit: 7,
      protectedLimit: 6,
      simplifyLimit: 5,
      visualStyle: "moderate text, compact spacing, more context and useful choices",
      presentation: {
        density: "rich",
        baseFontSize: 16,
        contentWidth: 1020,
        itemGap: 12,
        paddingX: 22,
        paddingY: 30
      },
      visual: {
        headingScale: 1.18,
        textScale: 1.02,
        fieldScale: 1,
        actionScale: 1.08,
        noticeScale: 1.02,
        lineHeight: 1.48,
        textMaxWidth: 860,
        fieldMaxWidth: 680,
        actionMaxWidth: 460
      },
      instructions: [
        "Keep enough context for learning and decision-making.",
        "Include useful supporting links, details, and next-step options when they are relevant.",
        "Remove bureaucratic clutter, ads, repeated navigation, and dense sidebars.",
        "Avoid making the page feel childish or overly stripped down."
      ]
    };
  }

  if (mentionsExpert) {
    return {
      profile: "expert_compact",
      informationDensity: "high",
      targetMinElements: 16,
      targetMaxElements: 28,
      maxElements: 32,
      maxRawItems: 38,
      readableLimit: 10,
      fieldLimit: 12,
      actionLimit: 9,
      protectedLimit: 7,
      simplifyLimit: 3,
      visualStyle: "compact controls, high information density, minimal rewriting",
      presentation: {
        density: "rich",
        baseFontSize: 15,
        contentWidth: 1080,
        itemGap: 10,
        paddingX: 20,
        paddingY: 28
      },
      visual: {
        headingScale: 1.08,
        textScale: 0.96,
        fieldScale: 0.96,
        actionScale: 1,
        noticeScale: 0.98,
        lineHeight: 1.42,
        textMaxWidth: 920,
        fieldMaxWidth: 720,
        actionMaxWidth: 420
      },
      instructions: [
        "Keep dense task-relevant information and controls.",
        "Remove obvious clutter and duplicate navigation.",
        "Rewrite labels only when clarity clearly improves."
      ]
    };
  }

  return {
    profile: "balanced_general",
    informationDensity: "medium",
    targetMinElements: 10,
    targetMaxElements: 18,
    maxElements: 22,
    maxRawItems: 28,
    readableLimit: 8,
    fieldLimit: 9,
    actionLimit: 5,
    protectedLimit: 6,
    simplifyLimit: 7,
    visualStyle: "readable text, moderate spacing, focused task flow",
    presentation: {
      density: "balanced",
      baseFontSize: 17,
      contentWidth: 920,
      itemGap: 16,
      paddingX: 24,
      paddingY: 34
    },
    visual: {
      headingScale: 1.28,
      textScale: 1.12,
      fieldScale: 1.06,
      actionScale: 1.18,
      noticeScale: 1.08,
      lineHeight: 1.6,
      textMaxWidth: 760,
      fieldMaxWidth: 640,
      actionMaxWidth: 520
    },
    instructions: [
      "Keep the main task, important context, required fields, and a few useful support options.",
      "Remove repeated navigation, ads, sidebars, and low-value extras.",
      "Use clear labels and comfortable spacing."
    ]
  };
}

function validateAndNormalize(parsed, domSummary, personaStrategy) {
  const allowedIds = new Set(domSummary.elements.map((el) => el.id));
  const elementById = new Map(domSummary.elements.map((el) => [el.id, el]));

  const rawItems =
    parsed?.mode === "reconstruct" || Array.isArray(parsed?.elements)
      ? parsed.elements
      : parsed?.reconstruction?.elements || parsed?.layout?.elements || [];

  let simplifyCount = 0;
  const usedIds = new Set();
  const elements = [];

  for (const item of (Array.isArray(rawItems) ? rawItems : []).slice(0, personaStrategy.maxRawItems)) {
    const targetId = String(item.targetId || "");
    if (!allowedIds.has(targetId)) continue;
    if (usedIds.has(targetId)) continue;

    const element = elementById.get(targetId);
    const isProtected = isProtectedElement(element);
    const purpose = normalizePurpose(item.purpose, element);

    const normalized = {
      targetId,
      purpose,
      reason: String(item.reason || "Useful in the simplified page.").slice(0, 180)
    };

    if (item.newText && !isProtected && canSimplifyTextElement(element)) {
      if (simplifyCount >= personaStrategy.simplifyLimit) continue;
      normalized.newText = String(item.newText).replace(/\s+/g, " ").trim().slice(0, 120);
      simplifyCount += 1;
    }

    const visual = normalizeVisual(item.visual || {}, element, purpose, personaStrategy);
    if (Object.keys(visual).length > 0) {
      normalized.visual = visual;
    }

    usedIds.add(targetId);
    elements.push(normalized);
  }

  const enhancedElements = enhanceReconstruction(elements, domSummary, personaStrategy);

  return {
    mode: "reconstruct",
    explanation: String(parsed.explanation || "Rebuilt the page as a simpler version using selected original elements.").slice(0, 320),
    personaProfile: personaStrategy.profile,
    presentation: normalizePresentation(parsed.presentation || {}, personaStrategy),
    elements: enhancedElements,
    actions: []
  };
}

function enhanceReconstruction(elements, domSummary, personaStrategy) {
  const result = [...elements];
  const usedIds = new Set(result.map((item) => item.targetId));

  const primaryElement = pickPrimaryCandidate(domSummary.elements);

  for (const readable of pickReadableSupport(domSummary.elements, primaryElement, personaStrategy.readableLimit)) {
    if (result.length >= personaStrategy.maxElements) break;

    addElement(result, usedIds, {
      targetId: readable.id,
      purpose: readable.tag?.startsWith("h") ? "heading" : isProtectedElement(readable) ? "notice" : "text",
      reason: "Important text for the simplified page.",
      visual: getDefaultVisual(readable.tag?.startsWith("h") ? "heading" : isProtectedElement(readable) ? "notice" : "text", readable, personaStrategy)
    });
  }

  for (const field of pickFormFields(domSummary.elements, primaryElement, personaStrategy.fieldLimit)) {
    if (result.length >= personaStrategy.maxElements) break;

    addElement(result, usedIds, {
      targetId: field.id,
      purpose: field.tag === "label" ? "text" : "field",
      reason: "Needed field for completing the main task.",
      visual: getDefaultVisual(field.tag === "label" ? "text" : "field", field, personaStrategy)
    });
  }

  if (primaryElement) {
    addElement(result, usedIds, {
      targetId: primaryElement.id,
      purpose: "primary_action",
      reason: "Main action for the simplified page.",
      visual: getDefaultVisual("primary_action", primaryElement, personaStrategy)
    });
  }

  for (const support of pickSupportingActions(domSummary.elements, primaryElement, personaStrategy.actionLimit)) {
    if (result.length >= personaStrategy.maxElements) break;

    if (support.isClickable) {
      addElement(result, usedIds, {
        targetId: support.id,
        purpose: "action",
        reason: "Useful secondary control.",
        visual: getDefaultVisual("action", support, personaStrategy)
      });
    }
  }

  for (const protectedElement of pickProtectedElements(domSummary.elements, personaStrategy.protectedLimit)) {
    if (result.length >= personaStrategy.maxElements + personaStrategy.protectedLimit) break;

    addElement(result, usedIds, {
      targetId: protectedElement.id,
      purpose: "notice",
      reason: "Required or safety-relevant information.",
      visual: getDefaultVisual("notice", protectedElement, personaStrategy)
    });
  }

  return orderReconstruction(result, domSummary.elements).slice(0, personaStrategy.maxElements);
}

function addElement(elements, usedIds, item) {
  if (usedIds.has(item.targetId)) return;

  elements.push(item);
  usedIds.add(item.targetId);
}

function normalizePurpose(purpose, element) {
  const value = String(purpose || "").toLowerCase();
  const allowed = new Set(["heading", "text", "field", "primary_action", "action", "notice", "support"]);

  if (allowed.has(value)) return value;
  if (isProtectedElement(element)) return "notice";
  if (["input", "select", "textarea"].includes(element?.tag)) return "field";
  if (element?.isClickable) return element?.intent?.includes("primary_candidate") ? "primary_action" : "action";
  if (element?.tag?.startsWith("h")) return "heading";
  return "text";
}

function normalizePresentation(rawPresentation, personaStrategy) {
  const presentation = rawPresentation && typeof rawPresentation === "object" ? rawPresentation : {};
  const normalized = { ...personaStrategy.presentation };

  if (["minimal", "balanced", "rich"].includes(presentation.density)) {
    normalized.density = presentation.density;
  }

  copyNumber(normalized, presentation, "baseFontSize", 14, 22);
  copyNumber(normalized, presentation, "contentWidth", 620, 1120);
  copyNumber(normalized, presentation, "itemGap", 8, 30);
  copyNumber(normalized, presentation, "paddingX", 16, 40);
  copyNumber(normalized, presentation, "paddingY", 24, 56);

  if (personaStrategy.profile === "elderly_accessible") {
    normalized.density = "minimal";
    normalized.baseFontSize = Math.max(normalized.baseFontSize, personaStrategy.presentation.baseFontSize);
    normalized.contentWidth = Math.min(normalized.contentWidth, personaStrategy.presentation.contentWidth);
    normalized.itemGap = Math.max(normalized.itemGap, personaStrategy.presentation.itemGap);
    normalized.paddingX = Math.max(normalized.paddingX, personaStrategy.presentation.paddingX);
    normalized.paddingY = Math.max(normalized.paddingY, personaStrategy.presentation.paddingY);
  }

  if (personaStrategy.profile === "student_contextual") {
    normalized.density = "rich";
    normalized.baseFontSize = Math.min(normalized.baseFontSize, personaStrategy.presentation.baseFontSize + 1);
    normalized.contentWidth = Math.max(normalized.contentWidth, personaStrategy.presentation.contentWidth);
    normalized.itemGap = Math.min(normalized.itemGap, personaStrategy.presentation.itemGap + 2);
  }

  return normalized;
}

function normalizeVisual(rawVisual, element, purpose, personaStrategy) {
  const visual = rawVisual && typeof rawVisual === "object" ? rawVisual : {};
  const normalized = getDefaultVisual(purpose, element, personaStrategy);
  const tag = element?.tag || "";
  const isControl = ["button", "a", "input", "select", "textarea"].includes(tag);

  copyNumber(normalized, visual, "fontScale", 0.85, 1.7);
  copyNumber(normalized, visual, "lineHeight", 1.2, 1.9);
  copyNumber(normalized, visual, "maxWidth", 240, 1000);

  if (isControl && ["comfortable", "full"].includes(visual.widthMode)) {
    normalized.widthMode = visual.widthMode;
  }

  if (["left", "center"].includes(visual.align)) {
    normalized.align = visual.align;
  }

  return enforcePersonaVisual(normalized, purpose, personaStrategy);
}

function enforcePersonaVisual(visual, purpose, personaStrategy) {
  const defaultVisual = getDefaultVisual(purpose, null, personaStrategy);

  if (personaStrategy.profile === "elderly_accessible") {
    visual.fontScale = Math.max(visual.fontScale || 1, defaultVisual.fontScale || 1.18);
    visual.lineHeight = Math.max(visual.lineHeight || 1.4, defaultVisual.lineHeight || 1.6);
    visual.maxWidth = Math.max(500, Math.min(visual.maxWidth || defaultVisual.maxWidth || 700, defaultVisual.maxWidth || 700));

    if (["field", "primary_action", "action"].includes(purpose)) {
      visual.widthMode = "comfortable";
    }
  }

  if (personaStrategy.profile === "student_contextual") {
    visual.fontScale = Math.max(0.95, Math.min(visual.fontScale || 1, Math.max(defaultVisual.fontScale || 1, 1.12)));
    visual.lineHeight = Math.max(1.38, Math.min(visual.lineHeight || 1.5, Math.max(defaultVisual.lineHeight || 1.45, 1.58)));
    visual.maxWidth = Math.max(visual.maxWidth || 760, defaultVisual.maxWidth || 760);
  }

  return visual;
}

function getDefaultVisual(purpose, element, personaStrategy) {
  const tag = element?.tag || "";
  const visual = personaStrategy.visual;
  const defaultPurpose = purpose || normalizePurpose("", element);
  const isControl = ["button", "a", "input", "select", "textarea"].includes(tag);

  if (defaultPurpose === "heading" || tag?.startsWith("h")) {
    return {
      fontScale: visual.headingScale,
      lineHeight: Math.max(1.18, visual.lineHeight - 0.18),
      maxWidth: Math.min(1000, Math.max(520, visual.textMaxWidth + 120))
    };
  }

  if (defaultPurpose === "primary_action") {
    return {
      fontScale: visual.actionScale,
      lineHeight: 1.25,
      widthMode: "comfortable",
      maxWidth: visual.actionMaxWidth,
      align: personaStrategy.profile === "student_contextual" ? "left" : "center"
    };
  }

  if (defaultPurpose === "action" || isControl) {
    return {
      fontScale: Math.max(0.9, visual.actionScale - 0.08),
      lineHeight: 1.3,
      widthMode: personaStrategy.profile === "elderly_accessible" ? "comfortable" : undefined,
      maxWidth: Math.max(320, visual.actionMaxWidth - 80)
    };
  }

  if (defaultPurpose === "field") {
    return {
      fontScale: visual.fieldScale,
      lineHeight: Math.max(1.35, visual.lineHeight - 0.1),
      widthMode: "comfortable",
      maxWidth: visual.fieldMaxWidth
    };
  }

  if (defaultPurpose === "notice") {
    return {
      fontScale: visual.noticeScale,
      lineHeight: visual.lineHeight,
      maxWidth: Math.min(1000, visual.textMaxWidth + 80)
    };
  }

  return {
    fontScale: visual.textScale,
    lineHeight: visual.lineHeight,
    maxWidth: visual.textMaxWidth
  };
}

function canSimplifyTextElement(element) {
  return Boolean(
    element &&
      (["button", "a", "label", "h1", "h2", "h3", "h4"].includes(element.tag) || element.role)
  );
}

function canHideElement(element) {
  if (!element || isProtectedElement(element)) return false;
  if (element.intent?.includes("primary_candidate")) return false;

  const text = getSearchText(element);
  if (/\b(apply|submit|continue|proceed|pay|checkout|sign in|login|next)\b/.test(text)) return false;

  return (
    isClutterCandidate(element) ||
    ["aside", "nav", "footer", "edge"].includes(element.area) ||
    (element.area === "header" && !["h1", "h2"].includes(element.tag))
  );
}

function pickDeletableClutter(elements) {
  return elements
    .filter(canHideElement)
    .sort((a, b) => scoreClutterCandidate(b) - scoreClutterCandidate(a))
    .slice(0, 24);
}

function pickProtectedElements(elements, limit = 5) {
  return elements
    .filter(isProtectedElement)
    .sort((a, b) => {
      const ay = a.rect?.y ?? 0;
      const by = b.rect?.y ?? 0;
      return ay - by;
    })
    .slice(0, limit);
}

function orderReconstruction(items, sourceElements) {
  const byId = new Map(sourceElements.map((el) => [el.id, el]));
  const purposeRank = {
    heading: 0,
    text: 1,
    field: 2,
    primary_action: 3,
    notice: 4,
    action: 5,
    support: 6
  };

  return [...items].sort((a, b) => {
    const rankDelta = (purposeRank[a.purpose] ?? 6) - (purposeRank[b.purpose] ?? 6);
    if (rankDelta !== 0) return rankDelta;

    const ay = byId.get(a.targetId)?.rect?.y ?? 0;
    const by = byId.get(b.targetId)?.rect?.y ?? 0;
    return ay - by;
  });
}

function restrictProtectedVisual(rawVisual) {
  const visual = rawVisual && typeof rawVisual === "object" ? rawVisual : {};

  return {
    fontScale: visual.fontScale,
    lineHeight: visual.lineHeight,
    spacingScale: visual.spacingScale,
    maxWidth: visual.maxWidth
  };
}

function copyNumber(target, source, key, min, max) {
  const value = source?.[key];
  if (value === undefined || value === null || value === "") return;

  const number = Number(value);
  if (!Number.isFinite(number)) return;

  target[key] = Math.min(max, Math.max(min, number));
}

function pickPrimaryCandidate(elements) {
  return elements
    .filter(isActionCandidate)
    .filter((el) => !isProtectedElement(el))
    .map((el) => ({
      el,
      score: scorePrimaryCandidate(el)
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)[0]?.el || null;
}

function scorePrimaryCandidate(el) {
  const text = getSearchText(el);
  let score = 0;

  if (["main", "form", "article", "section", "content"].includes(el.area)) score += 4;
  if (el.intent?.includes("primary_candidate")) score += 8;
  if (el.tag === "button" || el.role === "button") score += 4;
  if (el.tag === "a" || el.role === "link") score += 2;
  if (/\b(apply|start|continue|proceed|submit|next|sign in|login|checkout|buy|book|schedule|download)\b/.test(text)) score += 5;
  if (/\b(cancel|delete|remove|unsubscribe|reset)\b/.test(text)) score -= 10;
  if (["nav", "header", "footer", "aside"].includes(el.area)) score -= 4;

  const width = Math.max(el.rect?.width || 0, 1);
  const height = Math.max(el.rect?.height || 0, 1);
  if (width * height > 1200) score += 1;

  return score;
}

function pickReadableSupport(elements, primaryElement, limit = 8) {
  const primaryContext = primaryElement?.context || "";

  return elements
    .filter((el) => ["h1", "h2", "h3", "h4", "p", "li", "label"].includes(el.tag))
    .filter((el) => !isClutterCandidate(el))
    .filter((el) => ["main", "form", "article", "section", "content"].includes(el.area))
    .map((el) => ({
      el,
      score: scoreReadableSupport(el, primaryContext)
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.el);
}

function pickFormFields(elements, primaryElement, limit = 10) {
  const primaryContext = primaryElement?.context || "";

  return elements
    .filter((el) => ["label", "input", "select", "textarea"].includes(el.tag))
    .filter((el) => !isClutterCandidate(el))
    .filter((el) => ["main", "form", "article", "section", "content"].includes(el.area))
    .map((el) => ({
      el,
      score: scoreFormField(el, primaryContext)
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.el);
}

function pickSupportingActions(elements, primaryElement, limit = 8) {
  const primaryContext = primaryElement?.context || "";

  return elements
    .filter((el) => el.id !== primaryElement?.id)
    .filter((el) => !isProtectedElement(el) || ["h1", "h2", "h3", "h4", "p", "li"].includes(el.tag))
    .filter((el) => !isClutterCandidate(el))
    .filter((el) => ["main", "form", "article", "section", "content"].includes(el.area))
    .filter((el) => isActionCandidate(el) || el.intent?.includes("supporting"))
    .map((el) => ({
      el,
      score: scoreSupportingAction(el, primaryContext)
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.el);
}

function scoreFormField(el, primaryContext) {
  const text = getSearchText(el);
  let score = 0;

  if (el.area === "form") score += 5;
  if (el.context && primaryContext && el.context === primaryContext) score += 4;
  if (["input", "select", "textarea"].includes(el.tag)) score += 4;
  if (el.tag === "label") score += 3;
  if (/\b(name|email|phone|address|date|search|zip|city|state|password|account|application|question)\b/.test(text)) score += 2;
  if (/\b(hidden|token|csrf|captcha)\b/.test(text)) score -= 8;
  if (["nav", "header", "footer", "aside"].includes(el.area)) score -= 5;

  return score;
}

function scoreSupportingAction(el, primaryContext) {
  const text = getSearchText(el);
  let score = 0;

  if (el.context && primaryContext && el.context === primaryContext) score += 4;
  if (el.isClickable) score += 3;
  if (el.intent?.includes("supporting")) score += 4;
  if (/\b(help|support|contact|guide|instruction|download|details|learn|faq|view)\b/.test(text)) score += 3;
  if (el.intent?.includes("primary_candidate")) score += 2;
  if (["nav", "header", "footer", "aside"].includes(el.area)) score -= 5;

  return score;
}

function isActionCandidate(el) {
  if (!el) return false;
  if (el.tag === "button" || el.tag === "a") return true;
  if (el.role === "button" || el.role === "link") return true;

  if (el.tag === "input") {
    const type = String(el.type || "").toLowerCase();
    return ["button", "submit", "image"].includes(type);
  }

  return false;
}

function scoreReadableSupport(el, primaryContext) {
  const text = getSearchText(el);
  let score = 0;

  if (el.context && primaryContext && el.context === primaryContext) score += 4;
  if (["h1", "h2", "h3"].includes(el.tag)) score += 3;
  if (el.tag === "p" || el.tag === "li") score += 2;
  if (isProtectedElement(el)) score += 4;
  if (/\b(instruction|please|important|notice|required|before|after|step|choose|select)\b/.test(text)) score += 3;
  if ((el.text || "").length > 180) score -= 2;
  if (["nav", "header", "footer", "aside"].includes(el.area)) score -= 5;

  return score;
}

function pickClutter(elements) {
  return elements
    .filter(isClutterCandidate)
    .filter((el) => !isProtectedElement(el))
    .filter((el) => !["header", "footer"].includes(el.area))
    .sort((a, b) => scoreClutterCandidate(b) - scoreClutterCandidate(a))
    .slice(0, 8);
}

function scoreClutterCandidate(el) {
  let score = 0;

  if (el.area === "aside" || el.area === "edge") score += 4;
  if (el.intent?.includes("clutter_candidate")) score += 6;
  if (/\b(ad|advert|banner|newsletter|promo|campaign|survey|tourism|popular|event|related)\b/.test(getSearchText(el))) score += 5;
  if (el.isClickable) score += 1;

  return score;
}

function isClutterCandidate(el) {
  const text = getSearchText(el);
  return Boolean(
    el?.intent?.includes("clutter_candidate") ||
      /\b(ad|advert|banner|newsletter|promo|campaign|survey|tourism|popular|event|related)\b/.test(text)
  );
}

function isProtectedElement(el) {
  const protectedWords = [
    "warning", "error", "danger", "fee", "fees", "price", "payment", "legal", "privacy",
    "security", "terms", "consent", "required", "notice", "official", "verify", "verification",
    "password", "card", "credit", "bank", "medical"
  ];

  const text = getSearchText(el);
  return Boolean(el?.intent?.includes("protected") || protectedWords.some((word) => text.includes(word)));
}

function getSearchText(el) {
  return `${el?.text || ""} ${el?.ariaLabel || ""} ${el?.placeholder || ""} ${el?.context || ""}`.toLowerCase();
}

app.listen(port, () => {
  console.log(`PersonaLens backend running at http://localhost:${port}`);
});
