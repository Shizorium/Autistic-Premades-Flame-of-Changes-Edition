import { characterLevel, maskState, SYMBOLS, symbolDescription, symbolSlots } from "./data.js";

export function selectionContent(actor, item) {
  const escape = foundry.utils.escapeHTML;
  const level = characterLevel(actor), state = maskState(actor);
  const selected = state.itemId === item.id ? state.symbols ?? [] : [];
  const slots = symbolSlots(level);
  const rows = Array.from({ length: slots }, (_, index) => {
    const current = selected[index] ?? "";
    const options = [["", { name: "Без символа" }], ...Object.entries(SYMBOLS)].map(([key, symbol]) => {
      const text = symbolDescription(key, level);
      return `<button type="button" role="option" data-symbol="${key}" title="${escape(text)}" data-tooltip="${escape(text)}" aria-selected="${key === current}">${symbol.name}</button>`;
    }).join("");
    return `<div class="mask-symbol-row"><label>Символ ${index + 1}</label>
      <input type="hidden" name="symbol${index}" value="${current}">
      <details class="mask-symbol-dropdown"><summary aria-label="Символ ${index + 1}">${SYMBOLS[current]?.name ?? "Без символа"}</summary>
        <div role="listbox" aria-label="Символ ${index + 1}">${options}</div></details>
      <p class="mask-symbol-description">${escape(symbolDescription(current, level))}</p></div>`;
  }).join("");
  return `<div class="apfce-mask-picker"><p>Уровень ${level} · доступно символов: ${slots}. Наведите на символ в списке, чтобы увидеть его действие на текущем уровне.</p>
    <p>Символы можно менять и снимать в любое время. Выберите «Без символа», чтобы освободить место, или «Снять все символы», чтобы убрать их полностью. Одинаковые символы не складываются.</p>
    ${rows}${level > 10 ? "<p>Эффекты автоматизированы до 10-го уровня включительно; более высокие свойства сохраняются в описании.</p>" : ""}</div>`;
}

export function bindSymbolDropdowns(root) {
  const picker = root.querySelector(".apfce-mask-picker");
  if (!picker) return;
  const refresh = () => {
    const selected = [...picker.querySelectorAll('input[type="hidden"]')].map(input => input.value).filter(Boolean);
    for (const row of picker.querySelectorAll(".mask-symbol-row")) {
      const current = row.querySelector("input").value;
      for (const button of row.querySelectorAll("[data-symbol]")) {
        button.disabled = Boolean(button.dataset.symbol && button.dataset.symbol !== current && selected.includes(button.dataset.symbol));
        button.setAttribute("aria-selected", String(button.dataset.symbol === current));
      }
    }
  };
  picker.addEventListener("click", event => {
    const button = event.target.closest("button[data-symbol]");
    if (!button || button.disabled) return;
    const row = button.closest(".mask-symbol-row");
    row.querySelector("input").value = button.dataset.symbol;
    row.querySelector("summary").textContent = button.textContent;
    row.querySelector(".mask-symbol-description").textContent = button.title;
    row.querySelector("details").open = false;
    refresh();
  });
  picker.addEventListener("toggle", event => {
    if (!event.target.matches("details[open]")) return;
    for (const details of picker.querySelectorAll("details")) if (details !== event.target) details.open = false;
  }, true);
  refresh();
}

export async function chooseSymbols(actor, item) {
  return foundry.applications.api.DialogV2.wait({
    classes: ["apfce-mask-dialog"],
    window: { title: "Маска чёрной сотни — символы", resizable: true },
    position: { width: 540, height: 700 },
    content: selectionContent(actor, item),
    buttons: [
      { action: "apply", label: "Применить символы", default: true,
        callback: (_event, button) => Array.from({ length: symbolSlots(characterLevel(actor)) }, (_, i) => button.form.elements[`symbol${i}`].value).filter(Boolean)
      },
      { action: "clear", label: "Снять все символы", callback: () => [] },
      { action: "cancel", label: "Закрыть", callback: () => null }
    ],
    render: (_event, dialog) => bindSymbolDropdowns(dialog.element), rejectClose: false
  });
}
