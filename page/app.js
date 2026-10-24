/* global magpie */
//
// The pin editor. This page only edits the plugin's own options, which is what
// the provider reads when it builds a request. Probing and validation stay on
// the agent tool surface: a sandboxed page has no network and cannot see the
// plugin's state file.
//
;(async () => {
  "use strict";

  const MODELS = [
    ["deepseek-v4.1-flash-1017", "DeepSeek V4.1 Flash 1017"],
    ["deepseek-v4.1-flash", "DeepSeek V4.1 Flash"],
    ["deepseek-v4-pro", "DeepSeek V4 Pro"],
    ["deepseek-v4-flash", "DeepSeek V4 Flash"],
    ["glm-5.3", "GLM-5.3"],
    ["glm-5.3-flash", "GLM 5.3 Flash"],
    ["glm-5.2", "GLM-5.2"],
    ["kimi-k3", "Kimi K3"],
    ["kimi-k2.7-code", "Kimi K2.7 Code"],
    ["kimi-k2.6", "Kimi K2.6"],
    ["qwen3.8-max", "Qwen3.8 Max"],
    ["qwen3.7-max", "Qwen3.7 Max"],
    ["qwen3.7-plus", "Qwen3.7 Plus"],
    ["minimax-m3", "MiniMax-M3"],
    ["mimo-v2.6-flash", "MiMo-V2.6-Flash"],
    ["mimo-v2.6-pro", "MiMo-V2.6-Pro"],
    ["mimo-v2.5-pro", "MiMo-V2.5-Pro"],
    ["mimo-v2.5", "MiMo-V2.5"],
    ["muse-spark-1.3-contributor", "Muse Spark 1.3 Contributor"],
  ];

  const rows = document.getElementById("rows");
  const status = document.getElementById("status");
  const optionsView = document.getElementById("options");
  let options = {};

  const setStatus = (text, kind = "") => {
    status.textContent = text;
    status.dataset.kind = kind;
  };

  const splitList = (value) =>
    String(value || "")
      .split(/[,\s]+/)
      .map((item) => item.trim())
      .filter(Boolean);

  const modeOf = (pin) => {
    if (pin.pinMode === "preferred") return "preferred";
    if (pin.pinMode === "strict") return "strict";
    return Array.isArray(pin.upstreams) && pin.upstreams.length > 0 ? "strict" : "auto";
  };

  const makeSelect = (values) => {
    const select = document.createElement("select");
    for (const [value, label] of values) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      select.append(option);
    }
    return select;
  };

  const makeInput = (value, placeholder) => {
    const input = document.createElement("input");
    input.type = "text";
    input.value = value;
    input.placeholder = placeholder;
    input.spellcheck = false;
    return input;
  };

  const render = () => {
    rows.replaceChildren();
    const pins = options.pins && typeof options.pins === "object" ? options.pins : {};
    for (const [key, name] of MODELS) {
      const pin = pins[key] && typeof pins[key] === "object" ? pins[key] : {};
      const tr = document.createElement("tr");
      tr.dataset.model = key;

      const modelCell = document.createElement("td");
      modelCell.className = "model";
      const strong = document.createElement("strong");
      strong.textContent = name;
      const code = document.createElement("code");
      code.textContent = key;
      modelCell.append(strong, code);

      const modeCell = document.createElement("td");
      modeCell.className = "mode";
      const mode = makeSelect([
        ["auto", "自动"],
        ["strict", "strict"],
        ["preferred", "preferred"],
      ]);
      mode.value = modeOf(pin);
      modeCell.append(mode);

      const upstreamCell = document.createElement("td");
      const upstreams = makeInput(
        Array.isArray(pin.upstreams) ? pin.upstreams.join(", ") : "",
        "例如 deepseek, fireworks, baseten",
      );
      upstreamCell.append(upstreams);

      const hasCell = document.createElement("td");
      const has = makeInput(
        Array.isArray(pin.has) ? pin.has.join(", ") : "",
        "例如 vision, implicit-caching",
      );
      hasCell.append(has);

      const excludeCell = document.createElement("td");
      const exclude = makeInput(
        Array.isArray(pin.exclude) ? pin.exclude.join(", ") : "",
        "例如 wafer, morph",
      );
      excludeCell.append(exclude);

      const sortCell = document.createElement("td");
      sortCell.className = "sort";
      const sort = makeSelect([
        ["none", "不排序"],
        ["cost", "cost"],
        ["ttft", "ttft"],
        ["tps", "tps"],
      ]);
      sort.value = typeof pin.sort === "string" && pin.sort.length > 0 ? pin.sort : "none";
      sortCell.append(sort);

      mode.addEventListener("change", () => {
        if (mode.value === "auto") upstreams.value = "";
      });

      tr.append(modelCell, modeCell, upstreamCell, hasCell, excludeCell, sortCell);
      rows.append(tr);
    }
    optionsView.textContent = JSON.stringify(options, null, 2);
  };

  const load = async () => {
    try {
      const saved = await magpie.options.get();
      options = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
      render();
      setStatus("已读取当前钉住配置。", "ok");
    } catch (error) {
      setStatus("读取失败：" + String(error && error.message ? error.message : error), "error");
    }
  };

  const save = async (nextPins, message) => {
    try {
      const next = { ...options, pins: nextPins };
      const saved = await magpie.options.set(next);
      options = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : next;
      render();
      setStatus(message, "ok");
    } catch (error) {
      setStatus("保存失败：" + String(error && error.message ? error.message : error), "error");
    }
  };

  const readPins = () => {
    const pins = { ...(options.pins && typeof options.pins === "object" ? options.pins : {}) };
    for (const tr of rows.querySelectorAll("tr")) {
      const key = tr.dataset.model;
      delete pins[key];
      const mode = tr.querySelector("td.mode select").value;
      const upstreams = splitList(tr.children[2].querySelector("input").value);
      const has = splitList(tr.children[3].querySelector("input").value);
      const exclude = splitList(tr.children[4].querySelector("input").value);
      const sort = tr.children[5].querySelector("select").value;
      if (mode === "auto" && upstreams.length === 0 && has.length === 0 && exclude.length === 0 && sort === "none") continue;
      const pin = {};
      if (mode !== "auto") pin.pinMode = mode;
      if (upstreams.length > 0) pin.upstreams = upstreams;
      if (has.length > 0) pin.has = has;
      if (exclude.length > 0) pin.exclude = exclude;
      if (sort !== "none") pin.sort = sort;
      if (Object.keys(pin).length > 0) pins[key] = pin;
    }
    return pins;
  };

  document.getElementById("save").addEventListener("click", () => {
    void save(readPins(), "已保存。若请求仍在用旧规则，到「插件 → 已安装」把本插件关掉再打开。");
  });

  document.getElementById("reload").addEventListener("click", () => {
    void load();
  });

  document.getElementById("clear").addEventListener("click", () => {
    void save({}, "已清除全部钉住。若请求仍在用旧规则，到「插件 → 已安装」把本插件关掉再打开。");
  });

  try {
    await magpie.ready;
  } catch {
    // The bridge is optional at first paint; the options calls will report it.
  }
  await load();
})();
