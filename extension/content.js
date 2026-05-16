console.log("PersonaLens content script loaded:", window.location.href);

const PERSONA_LENS_ID_ATTR = "data-persona-lens-id";
const ORIGINAL_STYLE_ATTR = "data-persona-lens-original-style";
const ORIGINAL_TEXT_ATTR = "data-persona-lens-original-text";
const ORIGINAL_TITLE_ATTR = "data-persona-lens-original-title";
const ORIGINAL_PLACEHOLDER_ATTR = "data-persona-lens-original-placeholder";
const ORIGINAL_ARIA_LABEL_ATTR = "data-persona-lens-original-aria-label";
const TEXT_MUTATED_ATTR = "data-persona-lens-text-mutated";
const APPLIED_ATTR = "data-persona-lens-applied";
const RECONSTRUCTION_ROOT_ID = "persona-lens-reconstructed-page";

const MAX_ELEMENTS = 300;
let reconstructionPlacements = [];

function isVisible(el) {
  if (!(el instanceof HTMLElement)) return false;

  const style = window.getComputedStyle(el);
  const rect = el.getBoundingClientRect();

  if (style.display === "none") return false;
  if (style.visibility === "hidden") return false;
  if (Number(style.opacity) === 0) return false;
  if (rect.width <= 0 || rect.height <= 0) return false;

  return true;
}

function cleanText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

function getElementText(el) {
  if (!(el instanceof HTMLElement)) return "";

  const ariaLabel = el.getAttribute("aria-label");
  const placeholder = el.getAttribute("placeholder");
  const alt = el.getAttribute("alt");

  const ownText = cleanText(el.innerText || el.textContent || "");

  return cleanText(ariaLabel || placeholder || alt || ownText);
}

function getElementRole(el) {
  if (!(el instanceof HTMLElement)) return null;

  const explicitRole = el.getAttribute("role");
  if (explicitRole) return explicitRole;

  const tag = el.tagName.toLowerCase();

  if (tag === "button") return "button";
  if (tag === "a") return "link";
  if (tag === "input") return "input";
  if (tag === "textarea") return "textbox";
  if (tag === "select") return "select";
  if (tag === "img") return "image";
  if (tag === "h1" || tag === "h2" || tag === "h3") return "heading";

  return null;
}

function getElementArea(el) {
  if (!(el instanceof HTMLElement)) return "content";

  const areaEl = el.closest("main, nav, header, footer, aside, form, article, section");
  const tag = areaEl?.tagName?.toLowerCase();

  if (tag === "main" || tag === "article" || tag === "form") return tag;
  if (tag === "nav" || tag === "header" || tag === "footer" || tag === "aside") return tag;
  if (tag === "section") return "section";

  const rect = el.getBoundingClientRect();
  const viewportWidth = Math.max(window.innerWidth, 1);

  if (rect.left < viewportWidth * 0.18 || rect.right > viewportWidth * 0.82) {
    return "edge";
  }

  return "content";
}

function getElementIntent(el, text) {
  if (!(el instanceof HTMLElement)) return [];

  const value = `${text || ""} ${el.className || ""} ${el.id || ""}`.toLowerCase();
  const intents = [];

  if (isClickableElement(el)) intents.push("actionable");
  if (/\b(apply|start|continue|proceed|submit|next|sign in|login|checkout|buy|book|schedule|download)\b/.test(value)) {
    intents.push("primary_candidate");
  }
  if (/\b(help|support|contact|guide|instruction|learn|info|details|faq)\b/.test(value)) {
    intents.push("supporting");
  }
  if (/\b(ad|advert|banner|newsletter|promo|campaign|survey|tourism|popular|event|related)\b/.test(value)) {
    intents.push("clutter_candidate");
  }
  if (/\b(warning|important|notice|fee|price|payment|privacy|terms|security|required|verify|verification|official)\b/.test(value)) {
    intents.push("protected");
  }

  return intents;
}

function getNearbyContext(el) {
  if (!(el instanceof HTMLElement)) return "";

  const context = [];
  const region = el.closest("main, section, article, aside, nav, header, footer, form");

  if (region) {
    const regionLabel =
      region.getAttribute("aria-label") ||
      region.querySelector("h1, h2, h3")?.textContent ||
      region.tagName.toLowerCase();
    context.push(cleanText(regionLabel));
  }

  const precedingHeading = findPrecedingHeading(el);
  if (precedingHeading) {
    context.push(cleanText(precedingHeading.textContent));
  }

  return cleanText([...new Set(context.filter(Boolean))].join(" / "));
}

function findPrecedingHeading(el) {
  const headings = Array.from(document.querySelectorAll("h1, h2, h3, h4"))
    .filter((heading) => heading instanceof HTMLElement)
    .filter(isVisible);

  const elTop = el.getBoundingClientRect().top;
  let closest = null;
  let closestDistance = Infinity;

  for (const heading of headings) {
    const distance = elTop - heading.getBoundingClientRect().top;
    if (distance >= 0 && distance < closestDistance) {
      closest = heading;
      closestDistance = distance;
    }
  }

  return closest;
}

function assignPersonaLensId(el, index) {
  if (!el.getAttribute(PERSONA_LENS_ID_ATTR)) {
    el.setAttribute(PERSONA_LENS_ID_ATTR, `pl_${Date.now()}_${index}`);
  }

  return el.getAttribute(PERSONA_LENS_ID_ATTR);
}

function extractDOMSummary() {
  const selector = [
    "button",
    "a",
    "input",
    "textarea",
    "select",
    "label",
    "img",
    "form",
    "h1",
    "h2",
    "h3",
    "h4",
    "p",
    "li",
    "main",
    "section",
    "article",
    "aside",
    "nav",
    "div",
    "[role='button']",
    "[role='link']",
    "[aria-label]",
    "[onclick]"
  ].join(",");

  const candidates = Array.from(document.querySelectorAll(selector))
    .filter((el) => el instanceof HTMLElement)
    .filter(isVisible);

  const elements = [];

  for (let i = 0; i < candidates.length; i++) {
    if (elements.length >= MAX_ELEMENTS) break;

    const el = candidates[i];
    const rect = el.getBoundingClientRect();
    const text = getElementText(el);
    const tag = el.tagName.toLowerCase();
    const isContainerTag = ["div", "section", "aside", "nav", "article", "form"].includes(tag);

    const isUseful = isContainerTag
      ? text.length > 0 && text.length <= 220
      : text.length > 0 ||
        ["button", "a", "input", "textarea", "select", "img"].includes(tag) ||
        el.getAttribute("role") ||
        el.getAttribute("aria-label");

    if (!isUseful) continue;

    const id = assignPersonaLensId(el, i);
    const area = getElementArea(el);
    const intent = getElementIntent(el, text);

    elements.push({
      id,
      tag,
      role: getElementRole(el),
      text,
      ariaLabel: el.getAttribute("aria-label"),
      placeholder: el.getAttribute("placeholder"),
      href: el instanceof HTMLAnchorElement ? el.href : null,
      type: el.getAttribute("type"),
      isClickable: isClickableElement(el),
      area,
      intent,
      context: getNearbyContext(el),
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    });
  }

  return {
    url: window.location.href,
    title: document.title,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight
    },
    elements
  };
}

function isClickableElement(el) {
  if (!(el instanceof HTMLElement)) return false;

  const tag = el.tagName.toLowerCase();

  return (
    tag === "button" ||
    tag === "a" ||
    tag === "input" ||
    tag === "select" ||
    tag === "textarea" ||
    el.getAttribute("role") === "button" ||
    el.getAttribute("role") === "link" ||
    typeof el.onclick === "function" ||
    el.hasAttribute("onclick")
  );
}

function getTargetElement(targetId) {
  if (!targetId) return null;

  return document.querySelector(`[${PERSONA_LENS_ID_ATTR}="${CSS.escape(targetId)}"]`);
}

function saveOriginalState(el) {
  if (!(el instanceof HTMLElement)) return;

  if (!el.hasAttribute(ORIGINAL_STYLE_ATTR)) {
    el.setAttribute(ORIGINAL_STYLE_ATTR, el.getAttribute("style") || "");
  }

  if (!el.hasAttribute(ORIGINAL_TEXT_ATTR)) {
    el.setAttribute(ORIGINAL_TEXT_ATTR, el.innerText || "");
  }

  if (!el.hasAttribute(ORIGINAL_TITLE_ATTR)) {
    el.setAttribute(ORIGINAL_TITLE_ATTR, el.getAttribute("title") || "");
  }

  if (!el.hasAttribute(ORIGINAL_PLACEHOLDER_ATTR)) {
    el.setAttribute(ORIGINAL_PLACEHOLDER_ATTR, el.getAttribute("placeholder") || "");
  }

  if (!el.hasAttribute(ORIGINAL_ARIA_LABEL_ATTR)) {
    el.setAttribute(ORIGINAL_ARIA_LABEL_ATTR, el.getAttribute("aria-label") || "");
  }

  el.setAttribute(APPLIED_ATTR, "true");
}

function applyActions(result) {
  resetActions();

  if (isReconstructionResult(result)) {
    return applyReconstruction(result);
  }

  const actions = Array.isArray(result?.actions) ? result.actions : [];

  for (const action of actions) {
    const target = getTargetElement(action.targetId);
    if (!target) continue;

    if (shouldSkipActionForSafety(target, action)) {
      console.warn("PersonaLens skipped unsafe action:", action, target);
      continue;
    }

    saveOriginalState(target);

    switch (action.type) {
      case "hide":
      case "delete":
      case "remove":
        applyHide(target, action);
        break;

      case "readability":
        applyReadability(target, action);
        break;

      case "resize":
        applyResize(target, action);
        break;

      case "layout":
        applyLayout(target, action);
        break;

      case "translate":
      case "position":
        applyTranslate(target, action);
        break;

      case "simplify_text":
        applySimplifyText(target, action);
        break;

      default:
        console.warn("Unknown PersonaLens action:", action.type);
    }
  }

  return {
    appliedCount: document.querySelectorAll(`[${APPLIED_ATTR}="true"]`).length
  };
}

function isReconstructionResult(result) {
  return Boolean(
    result?.mode === "reconstruct" ||
      Array.isArray(result?.elements) ||
      Array.isArray(result?.reconstruction?.elements) ||
      Array.isArray(result?.layout?.elements)
  );
}

function getReconstructionItems(result) {
  return (
    result?.elements ||
    result?.reconstruction?.elements ||
    result?.layout?.elements ||
    []
  );
}

function applyReconstruction(result) {
  const items = getReconstructionItems(result);
  const presentation = getReconstructionPresentation(result?.presentation || {});
  const root = document.createElement("main");
  root.id = RECONSTRUCTION_ROOT_ID;
  root.setAttribute("aria-label", "Simplified page");
  root.style.cssText = [
    "box-sizing: border-box",
    `max-width: ${presentation.contentWidth}px`,
    "margin: 0 auto",
    `padding: ${presentation.paddingY}px ${presentation.paddingX}px ${Math.round(presentation.paddingY * 1.35)}px`,
    "min-height: 100vh",
    "font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    `font-size: ${presentation.baseFontSize}px`,
    "color: #202124",
    "background: canvas",
    "line-height: 1.55"
  ].join(";");

  const sources = [];

  for (const item of items) {
    const target = getTargetElement(item.targetId);
    const source = getReconstructionSource(target);
    if (!(source instanceof HTMLElement)) continue;
    if (!source.parentNode) continue;
    if (sources.includes(source)) continue;
    if (sources.some((existing) => existing.contains(source))) continue;
    if (sources.some((existing) => source.contains(existing))) continue;

    sources.push(source);
    const placeholder = document.createComment("persona-lens-original-position");

    source.parentNode.insertBefore(placeholder, source);
    prepareReconstructionElement(source, item, presentation, target);
    reconstructionPlacements.push({
      element: source,
      placeholder
    });
    root.appendChild(source);
  }

  if (root.children.length === 0) {
    return applyActions({ actions: Array.isArray(result?.actions) ? result.actions : [] });
  }

  for (const child of Array.from(document.body.children)) {
    if (!(child instanceof HTMLElement)) continue;
    if (child.id === RECONSTRUCTION_ROOT_ID) continue;

    saveOriginalState(child);
    child.style.display = "none";
  }

  document.body.appendChild(root);

  return {
    appliedCount: root.children.length
  };
}

function getReconstructionPresentation(rawPresentation) {
  const raw = rawPresentation && typeof rawPresentation === "object" ? rawPresentation : {};
  const density = ["minimal", "balanced", "rich"].includes(raw.density) ? raw.density : "balanced";

  return {
    density,
    baseFontSize: clampNumber(raw.baseFontSize, 14, 22) || 17,
    contentWidth: clampNumber(raw.contentWidth, 620, 1120) || 920,
    itemGap: clampNumber(raw.itemGap, 8, 30) || 16,
    paddingX: clampNumber(raw.paddingX, 16, 40) || 24,
    paddingY: clampNumber(raw.paddingY, 24, 56) || 34
  };
}

function getReconstructionSource(target) {
  if (!(target instanceof HTMLElement)) return null;

  const form = target.closest("form");
  if (form && form !== target && isFormRelatedElement(target)) {
    return form;
  }

  return target;
}

function isFormRelatedElement(el) {
  if (!(el instanceof HTMLElement)) return false;

  const tag = el.tagName.toLowerCase();

  return (
    ["button", "input", "select", "textarea", "label"].includes(tag) ||
    el.getAttribute("role") === "button"
  );
}

function prepareReconstructionElement(el, item, presentation, target = el) {
  const tag = el.tagName.toLowerCase();
  const purpose = item.purpose || item.role || "";
  const sizeScale = presentation.baseFontSize / 17;
  const isForm = tag === "form";
  const isField = !isForm && (["input", "select", "textarea"].includes(tag) || purpose === "field");
  const isAction =
    !isForm &&
    (
      purpose === "primary_action" ||
      purpose === "action" ||
      ["button", "a"].includes(tag) ||
      el.getAttribute("role") === "button" ||
      el.getAttribute("role") === "link"
    );

  saveOriginalState(el);
  resetNestedLayout(el);

  if (item.newText) {
    const textTarget = target instanceof HTMLElement && el.contains(target) ? target : el;
    applyReconstructionText(textTarget, cleanText(item.newText));
  }

  el.style.boxSizing = "border-box";
  el.style.position = "static";
  el.style.float = "none";
  el.style.inset = "auto";
  el.style.transform = "none";
  el.style.maxWidth = "100%";
  el.style.marginTop = "0";
  el.style.marginBottom = getPurposeMargin(purpose, tag, presentation);
  el.style.clear = "both";

  if (["h1", "h2", "h3", "h4"].includes(tag) || purpose === "heading") {
    el.style.display = "block";
    el.style.fontSize =
      tag === "h1"
        ? `clamp(${px(28, sizeScale)}, 4vw, ${px(42, sizeScale)})`
        : `clamp(${px(22, sizeScale)}, 3vw, ${px(30, sizeScale)})`;
    el.style.lineHeight = "1.18";
    el.style.fontWeight = "750";
    el.style.maxWidth = "880px";
  } else if (["p", "li", "label"].includes(tag) || purpose === "text" || purpose === "notice") {
    el.style.display = "block";
    el.style.fontSize = purpose === "notice" ? px(18, sizeScale) : px(17, sizeScale);
    el.style.lineHeight = "1.65";
    el.style.maxWidth = "760px";
  }

  if (isForm) {
    el.style.display = "grid";
    el.style.gap = px(Math.max(10, presentation.itemGap * 0.85), 1);
    el.style.width = "min(100%, 680px)";
    el.style.maxWidth = "680px";
    el.style.marginBottom = px(24, sizeScale);
    prepareNestedFormElements(el, presentation);
    prepareNestedSelectedElement(target, item, presentation);
  }

  if (isField) {
    el.style.display = "block";
    el.style.width = "min(100%, 620px)";
    el.style.maxWidth = "620px";
    el.style.minHeight = tag === "textarea" ? px(96, sizeScale) : px(48, sizeScale);
    el.style.fontSize = px(18, sizeScale);
    el.style.lineHeight = "1.45";
    el.style.padding = tag === "select" ? `${px(10, sizeScale)} ${px(12, sizeScale)}` : `${px(11, sizeScale)} ${px(12, sizeScale)}`;
    el.style.marginBottom = px(18, sizeScale);
  }

  if (isAction) {
    el.style.display = tag === "a" ? "inline-flex" : "flex";
    el.style.alignItems = "center";
    el.style.justifyContent = "center";
    el.style.width = purpose === "primary_action" ? "min(100%, 520px)" : "fit-content";
    el.style.fontSize = purpose === "primary_action" ? px(20, sizeScale) : px(17, sizeScale);
    el.style.minHeight = purpose === "primary_action" ? px(58, sizeScale) : px(46, sizeScale);
    el.style.padding =
      purpose === "primary_action"
        ? `${px(14, sizeScale)} ${px(20, sizeScale)}`
        : `${px(10, sizeScale)} ${px(14, sizeScale)}`;
    el.style.marginBottom = purpose === "primary_action" ? px(22, sizeScale) : px(14, sizeScale);
    el.style.maxWidth = purpose === "primary_action" ? "520px" : "420px";
  }

  if (!isForm) {
    applyReconstructionVisual(el, item.visual || {});
  }
}

function prepareNestedSelectedElement(target, item, presentation) {
  if (!(target instanceof HTMLElement)) return;

  const tag = target.tagName.toLowerCase();
  const purpose = item.purpose || item.role || "";
  const sizeScale = presentation.baseFontSize / 17;
  const isAction =
    purpose === "primary_action" ||
    purpose === "action" ||
    ["button", "a"].includes(tag) ||
    target.getAttribute("role") === "button" ||
    target.getAttribute("role") === "link" ||
    (tag === "input" && ["button", "submit"].includes(String(target.getAttribute("type") || "").toLowerCase()));

  const isField = ["input", "select", "textarea"].includes(tag) && !isAction;

  saveOriginalState(target);

  if (isAction) {
    target.style.display = tag === "a" ? "inline-flex" : "flex";
    target.style.alignItems = "center";
    target.style.justifyContent = "center";
    target.style.width = purpose === "primary_action" ? "min(100%, 520px)" : "fit-content";
    target.style.maxWidth = purpose === "primary_action" ? "520px" : "420px";
    target.style.minHeight = purpose === "primary_action" ? px(58, sizeScale) : px(48, sizeScale);
    target.style.fontSize = purpose === "primary_action" ? px(20, sizeScale) : px(18, sizeScale);
    target.style.padding =
      purpose === "primary_action"
        ? `${px(14, sizeScale)} ${px(20, sizeScale)}`
        : `${px(11, sizeScale)} ${px(16, sizeScale)}`;
  }

  if (isField) {
    target.style.display = "block";
    target.style.width = "min(100%, 620px)";
    target.style.maxWidth = "620px";
    target.style.minHeight = tag === "textarea" ? px(96, sizeScale) : px(48, sizeScale);
    target.style.fontSize = px(18, sizeScale);
    target.style.padding = `${px(11, sizeScale)} ${px(12, sizeScale)}`;
  }

  applyReconstructionVisual(target, item.visual || {});
}

function getPurposeMargin(purpose, tag, presentation) {
  const gap = presentation.itemGap;

  if (purpose === "primary_action") return `${Math.round(gap * 1.35)}px`;
  if (purpose === "field") return `${Math.round(gap * 1.1)}px`;
  if (purpose === "notice") return `${Math.round(gap * 1.15)}px`;
  if (["h1", "h2", "h3", "h4"].includes(tag)) return `${Math.round(gap * 1.2)}px`;
  return `${Math.round(gap)}px`;
}

function resetNestedLayout(root) {
  const descendants = Array.from(root.querySelectorAll("*"));

  for (const node of descendants) {
    if (!(node instanceof HTMLElement)) continue;

    saveOriginalState(node);
    node.style.boxSizing = "border-box";
    node.style.position = "static";
    node.style.float = "none";
    node.style.inset = "auto";
    node.style.transform = "none";
    node.style.maxWidth = "100%";
  }
}

function prepareNestedFormElements(form, presentation) {
  const sizeScale = presentation.baseFontSize / 17;
  const fields = form.querySelectorAll("input, select, textarea");
  const labels = form.querySelectorAll("label");
  const actions = form.querySelectorAll("button, a, [role='button'], input[type='button'], input[type='submit']");

  labels.forEach((label) => {
    if (!(label instanceof HTMLElement)) return;

    saveOriginalState(label);
    label.style.display = "block";
    label.style.margin = "4px 0 2px";
    label.style.fontSize = px(17, sizeScale);
    label.style.lineHeight = "1.45";
    label.style.maxWidth = "620px";
  });

  fields.forEach((field) => {
    if (!(field instanceof HTMLElement)) return;

    saveOriginalState(field);
    field.style.display = "block";
    field.style.width = "min(100%, 620px)";
    field.style.maxWidth = "620px";
    field.style.minHeight = field.tagName.toLowerCase() === "textarea" ? px(96, sizeScale) : px(48, sizeScale);
    field.style.fontSize = px(18, sizeScale);
    field.style.lineHeight = "1.45";
    field.style.padding = `${px(11, sizeScale)} ${px(12, sizeScale)}`;
  });

  actions.forEach((action) => {
    if (!(action instanceof HTMLElement)) return;

    saveOriginalState(action);
    action.style.display = action.tagName.toLowerCase() === "a" ? "inline-flex" : "flex";
    action.style.alignItems = "center";
    action.style.justifyContent = "center";
    action.style.width = "fit-content";
    action.style.maxWidth = "520px";
    action.style.minHeight = px(48, sizeScale);
    action.style.fontSize = px(18, sizeScale);
    action.style.padding = `${px(11, sizeScale)} ${px(16, sizeScale)}`;
    action.style.marginTop = px(6, sizeScale);
  });
}

function px(value, scale = 1) {
  return `${Math.round(value * scale)}px`;
}

function applyReconstructionText(el, newText) {
  if (!newText) return;

  const tag = el.tagName.toLowerCase();

  if (tag === "input" || tag === "textarea") {
    el.setAttribute("placeholder", newText);
    return;
  }

  if (replaceVisibleText(el, newText)) {
    el.setAttribute(TEXT_MUTATED_ATTR, "true");
  }
}

function applyReconstructionVisual(el, visual) {
  const tag = el.tagName.toLowerCase();

  const fontScale = clampNumber(visual.fontScale, 0.85, 1.7);
  if (fontScale) {
    el.style.fontSize = `${Math.round(fontScale * 100)}%`;
  }

  const lineHeight = clampNumber(visual.lineHeight, 1.2, 1.9);
  if (lineHeight) {
    el.style.lineHeight = String(lineHeight);
  }

  const maxWidth = clampNumber(visual.maxWidth, 240, 1000);
  if (maxWidth) {
    el.style.maxWidth = `${Math.round(maxWidth)}px`;
  }

  if (visual.widthMode === "comfortable") {
    el.style.display = tag === "a" ? "inline-block" : "block";
    el.style.width = ["input", "select", "textarea"].includes(tag) ? "min(100%, 620px)" : "min(100%, 520px)";
  }

  if (visual.widthMode === "full") {
    el.style.display = "block";
    el.style.width = "100%";
  }

  if (visual.align === "center") {
    el.style.marginLeft = "auto";
    el.style.marginRight = "auto";
    el.style.textAlign = "center";
  }
}

function shouldSkipActionForSafety(el, action) {
  const text = getElementText(el).toLowerCase();

  const protectedKeywords = [
    "warning",
    "error",
    "danger",
    "fee",
    "price",
    "payment",
    "total",
    "privacy",
    "terms",
    "security",
    "password",
    "verification",
    "required",
    "consent",
    "legal",
    "delete",
    "remove",
    "cancel",
    "unsubscribe",
    "medical",
    "diagnosis",
    "bank",
    "card",
    "credit"
  ];

  const containsProtectedKeyword = protectedKeywords.some((keyword) =>
    text.includes(keyword)
  );

  if (["hide", "delete", "remove", "translate", "position"].includes(action.type) && containsProtectedKeyword) {
    return true;
  }

  if (action.type === "simplify_text") {
    const tag = el.tagName.toLowerCase();

    const safeTextTargets = [
      "button",
      "a",
      "label",
      "h1",
      "h2",
      "h3",
      "h4"
    ];

    if (!safeTextTargets.includes(tag) && !el.getAttribute("role")) {
      return true;
    }

    if (containsProtectedKeyword) {
      return true;
    }

    if (!action.newText || String(action.newText).trim().length === 0) {
      return true;
    }

    if (String(action.newText).length > 80) {
      return true;
    }

    if (hasNestedInteractiveContent(el)) {
      return true;
    }
  }

  return false;
}

function hasNestedInteractiveContent(el) {
  if (!(el instanceof HTMLElement)) return true;

  return Boolean(
    el.querySelector("button, a, input, select, textarea, [role='button'], [role='link']")
  );
}

function applyHide(el, action) {
  el.style.display = "none";

  if (action.reason) {
    el.setAttribute("title", action.reason);
  }
}

function applyReadability(el, action) {
  const visual = action.visual || {};
  const fontScale = clampNumber(visual.fontScale, 1.08, 1.55) || 1.16;
  const lineHeight = clampNumber(visual.lineHeight, 1.35, 1.85) || 1.6;
  const maxWidth = clampNumber(visual.maxWidth, 320, 900);

  el.style.fontSize = `${Math.round(fontScale * 100)}%`;
  el.style.lineHeight = String(lineHeight);

  if (maxWidth) {
    el.style.maxWidth = `${Math.round(maxWidth)}px`;
  }

  if (action.reason) {
    el.setAttribute("title", action.reason);
  }
}

function applyResize(el, action) {
  const visual = action.visual || {};
  const tag = el.tagName.toLowerCase();
  const isControl = ["button", "a", "input", "select", "textarea"].includes(tag);

  const fontScale = clampNumber(visual.fontScale, 1, 1.55) || (isControl ? 1.18 : null);
  const paddingScale = clampNumber(visual.paddingScale, 1, 2) || (isControl ? 1.35 : null);
  const minTapTarget = clampNumber(visual.minTapTarget, 36, 80) || (isControl ? 52 : null);
  const width = clampNumber(visual.width, 120, 900);
  const maxWidth = clampNumber(visual.maxWidth, 240, 1000);
  const scale = clampNumber(visual.scale, 0.8, 1.25);

  if (fontScale) {
    el.style.fontSize = `${Math.round(fontScale * 100)}%`;
  }

  if (paddingScale) {
    el.style.paddingBlock = `${Math.round(8 * paddingScale)}px`;
    el.style.paddingInline = `${Math.round(12 * paddingScale)}px`;
  }

  if (minTapTarget && isControl) {
    el.style.minHeight = `${Math.round(minTapTarget)}px`;
    el.style.minWidth = `${Math.round(minTapTarget)}px`;
  }

  if (width) {
    el.style.width = `${Math.round(width)}px`;
  } else if (visual.widthMode === "comfortable" && isControl) {
    el.style.display = tag === "a" ? "inline-block" : "block";
    el.style.width = "min(100%, 440px)";
  }

  if (maxWidth) {
    el.style.maxWidth = `${Math.round(maxWidth)}px`;
  }

  if (scale) {
    mergeTransform(el, { scale });
  }

  if (action.reason) {
    el.setAttribute("title", action.reason);
  }
}

function applyLayout(el, action) {
  const visual = action.visual || {};
  const spacingScale = clampNumber(visual.spacingScale, 0.5, 3);
  const maxWidth = clampNumber(visual.maxWidth, 280, 1000);

  if (spacingScale) {
    el.style.marginTop = `${Math.round(8 * spacingScale)}px`;
    el.style.marginBottom = `${Math.round(10 * spacingScale)}px`;
  }

  if (maxWidth) {
    el.style.maxWidth = `${Math.round(maxWidth)}px`;
  }

  if (visual.align === "center") {
    el.style.display = el.tagName.toLowerCase() === "a" ? "inline-block" : "block";
    el.style.marginLeft = "auto";
    el.style.marginRight = "auto";
  }

  if (action.reason) {
    el.setAttribute("title", action.reason);
  }
}

function applyTranslate(el, action) {
  if (!(el instanceof HTMLElement)) return;

  const visual = action.visual || action.style || {};
  const shiftX = clampNumber(visual.shiftX, -80, 80) || 0;
  const shiftY = clampNumber(visual.shiftY, -80, 80) || 0;
  const scale = clampNumber(visual.scale, 0.85, 1.18);
  const order = clampNumber(visual.order, -10, 10);

  if (shiftX || shiftY || scale) {
    mergeTransform(el, { shiftX, shiftY, scale });
    el.style.position = "relative";
    el.style.zIndex = "2147483000";
  }

  if (order !== null) {
    el.style.order = String(Math.round(order));
  }

  if (action.reason) {
    el.setAttribute("title", action.reason);
  }
}

function mergeTransform(el, { shiftX = 0, shiftY = 0, scale = null }) {
  const transformParts = [];

  if (shiftX || shiftY) {
    transformParts.push(`translate(${Math.round(shiftX)}px, ${Math.round(shiftY)}px)`);
  }

  if (scale) {
    transformParts.push(`scale(${scale})`);
  }

  if (transformParts.length > 0) {
    el.style.transform = transformParts.join(" ");
  }
}

function clampNumber(value, min, max) {
  if (value === undefined || value === null || value === "") return null;

  const number = Number(value);
  if (!Number.isFinite(number)) return null;

  return Math.min(max, Math.max(min, number));
}

function applySimplifyText(el, action) {
  const newText = cleanText(action.newText);

  if (!newText) return;

  const tag = el.tagName.toLowerCase();

  if (tag === "input" || tag === "textarea") {
    el.setAttribute("placeholder", newText);
  } else if (replaceVisibleText(el, newText)) {
    el.setAttribute(TEXT_MUTATED_ATTR, "true");
  } else {
    el.setAttribute("aria-label", newText);
    el.setAttribute("title", newText);
  }

  if (action.reason) {
    el.setAttribute("title", action.reason);
  }
}

function replaceVisibleText(el, newText) {
  if (!(el instanceof HTMLElement)) return false;

  if (el.children.length === 0) {
    el.innerText = newText;
    return true;
  }

  if (el.children.length === 1) {
    const child = el.children[0];

    if (
      child instanceof HTMLElement &&
      child.children.length === 0 &&
      child.textContent?.trim()
    ) {
      child.textContent = newText;
      return true;
    }
  }

  return false;
}

function resetActions() {
  restoreReconstructionPlacements();
  document.getElementById(RECONSTRUCTION_ROOT_ID)?.remove();

  const changedElements = document.querySelectorAll(`[${APPLIED_ATTR}="true"]`);

  changedElements.forEach((node) => {
    if (!(node instanceof HTMLElement)) return;

    const originalStyle = node.getAttribute(ORIGINAL_STYLE_ATTR);
    const originalText = node.getAttribute(ORIGINAL_TEXT_ATTR);
    const originalTitle = node.getAttribute(ORIGINAL_TITLE_ATTR);
    const originalPlaceholder = node.getAttribute(ORIGINAL_PLACEHOLDER_ATTR);
    const originalAriaLabel = node.getAttribute(ORIGINAL_ARIA_LABEL_ATTR);

    if (originalStyle !== null) {
      if (originalStyle) {
        node.setAttribute("style", originalStyle);
      } else {
        node.removeAttribute("style");
      }
    }

    if (originalText !== null && node.hasAttribute(TEXT_MUTATED_ATTR)) {
      const tag = node.tagName.toLowerCase();

      if (tag === "input" || tag === "textarea") {
        // We only changed placeholder for these, so do not overwrite input value.
      } else {
        node.innerText = originalText;
      }
    }

    if (originalTitle !== null) {
      if (originalTitle) {
        node.setAttribute("title", originalTitle);
      } else {
        node.removeAttribute("title");
      }
    }

    if (originalPlaceholder !== null) {
      if (originalPlaceholder) {
        node.setAttribute("placeholder", originalPlaceholder);
      } else {
        node.removeAttribute("placeholder");
      }
    }

    if (originalAriaLabel !== null) {
      if (originalAriaLabel) {
        node.setAttribute("aria-label", originalAriaLabel);
      } else {
        node.removeAttribute("aria-label");
      }
    }

    node.removeAttribute(ORIGINAL_STYLE_ATTR);
    node.removeAttribute(ORIGINAL_TEXT_ATTR);
    node.removeAttribute(ORIGINAL_TITLE_ATTR);
    node.removeAttribute(ORIGINAL_PLACEHOLDER_ATTR);
    node.removeAttribute(ORIGINAL_ARIA_LABEL_ATTR);
    node.removeAttribute(TEXT_MUTATED_ATTR);
    node.removeAttribute(APPLIED_ATTR);
  });

  return {
    ok: true
  };
}

function restoreReconstructionPlacements() {
  for (const placement of [...reconstructionPlacements].reverse()) {
    const { element, placeholder } = placement;

    if (placeholder?.parentNode && element instanceof HTMLElement) {
      placeholder.parentNode.insertBefore(element, placeholder);
      placeholder.remove();
    }
  }

  reconstructionPlacements = [];
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  try {
    if (message.type === "PING") {
      sendResponse({
        ok: true
      });
      return true;
    }

    if (message.type === "EXTRACT_DOM") {
      const summary = extractDOMSummary();

      sendResponse({
        ok: true,
        summary
      });

      return true;
    }

    if (message.type === "APPLY_ACTIONS") {
      const result = message.payload;
      const applyResult = applyActions(result);

      sendResponse({
        ok: true,
        ...applyResult
      });

      return true;
    }

    if (message.type === "RESET_ACTIONS") {
      resetActions();

      sendResponse({
        ok: true
      });

      return true;
    }

    sendResponse({
      ok: false,
      error: `Unknown message type: ${message.type}`
    });

    return true;
  } catch (error) {
    console.error("PersonaLens content script error:", error);

    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });

    return true;
  }
});
