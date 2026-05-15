// options/options.js
import { testNotion } from "../sidepanel/notion.js";

const SETTINGS_KEY = "rnc:settings";
const $ = (id) => document.getElementById(id);

async function load() {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  const s = data[SETTINGS_KEY] || {};
  $("token").value = s.token || "";
  $("databaseId").value = s.databaseId || "";
  const color = s.defaultColor || "yellow";
  const radio = document.querySelector(
    'input[name="defaultColor"][value="' + color + '"]'
  );
  if (radio) radio.checked = true;
}

function currentSettings() {
  const checked = document.querySelector('input[name="defaultColor"]:checked');
  return {
    token: $("token").value.trim(),
    databaseId: $("databaseId").value.trim(),
    defaultColor: checked ? checked.value : "yellow",
  };
}

async function save() {
  const settings = currentSettings();
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  const r = $("saveResult");
  r.textContent = "✓ 已保存";
  r.className = "save-result ok";
  setTimeout(() => {
    r.textContent = "";
  }, 2500);
}

async function test() {
  const r = $("testResult");
  const settings = currentSettings();
  if (!settings.token || !settings.databaseId) {
    r.textContent = "请先填写 Token 和 Database ID";
    r.className = "test-result err";
    return;
  }
  r.textContent = "测试中…";
  r.className = "test-result";
  try {
    const info = await testNotion(settings);
    const extras = [];
    if (info.hasUrl) extras.push("可写入来源链接");
    if (info.hasDate) extras.push("可写入剪藏日期");
    r.textContent =
      "✓ 已连接：" +
      info.title +
      "（标题字段「" +
      info.titleProp +
      "」" +
      (extras.length ? "，" + extras.join("、") : "") +
      "）";
    r.className = "test-result ok";
    // 顺手保存一次，省得用户忘记
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  } catch (e) {
    r.textContent = "✗ " + (e.message || e);
    r.className = "test-result err";
  }
}

$("btnSave").addEventListener("click", save);
$("btnTest").addEventListener("click", test);
load();
