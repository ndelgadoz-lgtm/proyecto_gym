"use strict";

const state = {
  user: null,
  clientGoogleId: null,
  data: null,
  entrenoKey: null,
  microIndex: 0,
  records: {},
};

/* ---------- utils ---------- */

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: opts.body ? { "Content-Type": "application/json" } : {},
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && path !== "/api/auth/me") {
    state.user = null;
    showLogin();
    throw new Error("No autenticado");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

function showView(id, showChrome) {
  document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
  document.getElementById(id).classList.remove("hidden");
  document.getElementById("topbar").classList.toggle("hidden", !showChrome);
}

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add("hidden"), 2200);
}

function recKey(entrenoKey, microIndex, row) {
  return `${entrenoKey}|${microIndex}|${row}`;
}

function parseSets(text) {
  return String(text)
    .split("/")
    .map((part) => {
      const p = part.trim();
      const kg = /([\d.,]+)\s*kg/i.exec(p);
      const reps = /x\s*([\d.,]+)/i.exec(p);
      return {
        kg: kg ? parseFloat(kg[1].replace(",", ".")) : null,
        reps: reps ? parseFloat(reps[1].replace(",", ".")) : null,
      };
    });
}

function fmtNum(n) {
  return Number.isInteger(n) ? String(n) : String(parseFloat(n.toFixed(2)));
}

/* ---------- login ---------- */

function showLogin() {
  showView("view-login", false);
  initGoogle();
}

let googleTries = 0;
function initGoogle() {
  if (!state.clientGoogleId) {
    fetch("/api/config")
      .then((r) => r.json())
      .then((c) => {
        state.clientGoogleId = c.googleClientId;
        initGoogle();
      })
      .catch(() => {});
    return;
  }
  if (!window.google || !window.google.accounts || !google.accounts.id) {
    googleTries++;
    if (googleTries > 40) {
      const el = document.getElementById("login-error");
      el.textContent = "No se pudo cargar Google Sign-In (¿sin conexión?).";
      el.classList.remove("hidden");
      return;
    }
    return setTimeout(initGoogle, 250);
  }
  if (initGoogle._done) return;
  initGoogle._done = true;
  google.accounts.id.initialize({
    client_id: state.clientGoogleId,
    callback: async (resp) => {
      try {
        const user = await api("/api/auth/google", {
          method: "POST",
          body: { credential: resp.credential },
        });
        state.user = user;
        await afterLogin();
      } catch (e) {
        const el = document.getElementById("login-error");
        el.textContent = e.message;
        el.classList.remove("hidden");
      }
    },
  });
  google.accounts.id.renderButton(document.getElementById("gbtn"), {
    theme: "filled_black",
    size: "large",
    width: 280,
    text: "continue_with",
  });
}

async function afterLogin() {
  const av = document.getElementById("avatar");
  if (state.user.picture) {
    av.src = state.user.picture;
    av.classList.remove("hidden");
  }
  document.getElementById("hello").textContent = state.user.name
    ? `Hola, ${state.user.name.split(" ")[0]}`
    : "Hola";

  state.data = await api("/api/trainings");
  const rec = await api("/api/records");
  state.records = rec.records || {};

  const entrenos = state.data.entrenos.filter((e) => e.microciclos.length);
  const cur = state.data.current;
  const curEntreno = cur ? entrenos.find((e) => e.key === cur.entrenoKey) : null;

  if (!entrenos.length) {
    renderEmpty();
    showView("view-app", true);
    return;
  }

  if (curEntreno) {
    state.entrenoKey = curEntreno.key;
    state.microIndex = cur.microIndex;
  } else {
    state.entrenoKey = entrenos[0].key;
    state.microIndex = 0;
  }

  renderBadge();
  renderTabs();
  renderWeeks();
  renderWeek();
  showView("view-app", true);
}

function renderEmpty() {
  document.getElementById("trainer-tabs").innerHTML = "";
  document.getElementById("week-strip").innerHTML = "";
  document.getElementById("week-content").innerHTML =
    `<div class="empty">No se encontraron entrenos en las hojas de cálculo.</div>`;
}

/* ---------- render ---------- */

function getEntreno() {
  return state.data.entrenos.find((e) => e.key === state.entrenoKey);
}

function renderBadge() {
  const badge = document.getElementById("current-badge");
  const cur = state.data.current;
  if (!cur) {
    badge.classList.add("hidden");
    return;
  }
  const e = state.data.entrenos.find((x) => x.key === cur.entrenoKey);
  const mi = e && e.microciclos[cur.microIndex];
  if (!e || !mi) {
    badge.classList.add("hidden");
    return;
  }
  badge.textContent = `Semana actual · ${e.name} · ${mi.name}`;
  badge.classList.remove("hidden");
}

function renderTabs() {
  const wrap = document.getElementById("trainer-tabs");
  const cur = state.data.current;
  wrap.innerHTML = state.data.entrenos
    .map((e, i) => {
      const active = e.key === state.entrenoKey;
      const isCur = cur && cur.entrenoKey === e.key;
      const dot = isCur ? " ●" : "";
      const label = e.name || `Entreno ${i + 1}`;
      return `<button class="trainer-tab ${active ? "active" : ""}" data-key="${e.key}">
        <span class="tab-name">${esc(label)}${dot}</span>
      </button>`;
    })
    .join("");
  wrap.querySelectorAll(".trainer-tab").forEach((b) => {
    b.onclick = () => {
      if (b.dataset.key === state.entrenoKey) return;
      state.entrenoKey = b.dataset.key;
      const cur2 = state.data.current;
      state.microIndex =
        cur2 && cur2.entrenoKey === state.entrenoKey ? cur2.microIndex : 0;
      renderTabs();
      renderWeeks();
      renderWeek();
    };
  });
}

function isExerciseDone(ex) {
  const record = state.records[recKey(state.entrenoKey, state.microIndex, ex.row)];
  return !!(record && String(record).trim());
}

function isDayDone(day) {
  if (day.rest) return true;
  if (!day.exercises || day.exercises.length === 0) return false;
  return day.exercises.every((ex) => isExerciseDone(ex));
}

function isWeekDone(mi) {
  if (!mi || !mi.days || mi.days.length === 0) return false;
  const days = mi.days.filter((d) => !d.rest);
  if (days.length === 0) return false;
  return days.every((d) => isDayDone(d));
}

function renderWeeks() {
  const wrap = document.getElementById("week-strip");
  const e = getEntreno();
  const cur = state.data.current;
  if (!e) {
    wrap.innerHTML = "";
    return;
  }
  wrap.innerHTML = e.microciclos
    .map((mi) => {
      const active = mi.index === state.microIndex;
      const isCur =
        cur && cur.entrenoKey === state.entrenoKey && cur.microIndex === mi.index;
      const label = mi.name.replace(/^MICROCICLO\s*/i, "SEM ");
      const done = isWeekDone(mi);
      return `<button class="week-chip ${active ? "active" : ""} ${
        isCur ? "current" : ""
      } ${done ? "completed" : "incomplete"}" data-mi="${mi.index}">
        <span class="chip-label">${esc(label)}</span>
        ${isCur ? `<span class="chip-now">ACTUAL</span>` : ""}
      </button>`;
    })
    .join("");
  wrap.querySelectorAll(".week-chip").forEach((b) => {
    b.onclick = () => {
      state.microIndex = parseInt(b.dataset.mi, 10);
      renderWeeks();
      renderWeek();
    };
  });
}

function exerciseHtml(ex) {
  const record = state.records[recKey(state.entrenoKey, state.microIndex, ex.row)];
  const pref = record ? parseSets(record) : [];
  const rows = Array.from({ length: ex.sets })
    .map((_, i) => {
      const s = pref[i] || {};
      const kg = s.kg !== null && s.kg !== undefined ? `value="${s.kg}"` : "";
      const reps = s.reps !== null && s.reps !== undefined ? `value="${s.reps}"` : "";
      return `
      <div class="set-row" data-set="${i + 1}">
        <span class="set-num">${i + 1}</span>
        <input class="in-kg" type="number" inputmode="decimal" step="0.5" min="0" placeholder="kg" ${kg}>
        <span class="sep">×</span>
        <input class="in-reps" type="number" inputmode="numeric" step="1" min="0" placeholder="reps" ${reps}>
      </div>`;
    })
    .join("");
  const saved = record
    ? `<span>Registrado: <b class="vals">${esc(record)}</b></span>`
    : `<span class="muted">Sin registros todavía</span>`;
  return `
    <div class="ex-card" data-row="${ex.row}">
      <button class="ex-toggle" type="button">
        <span class="ex-name">${esc(ex.name)}</span>
        <span class="ex-meta">${ex.sets} series · ${esc(ex.target)}</span>
      </button>
      <div class="ex-body hidden">
        ${rows}
        <div class="ex-actions">
          <span class="ex-saved">${saved}</span>
          <button class="ex-save primary small" type="button">Guardar</button>
        </div>
      </div>
    </div>`;
}

function renderWeek() {
  const wrap = document.getElementById("week-content");
  const e = getEntreno();
  if (!e) {
    wrap.innerHTML = "";
    return;
  }
  const mi = e.microciclos[state.microIndex];
  if (!mi) {
    wrap.innerHTML = `<div class="empty">Este entreno no tiene semanas.</div>`;
    return;
  }

  wrap.innerHTML = mi.days
    .map((d) => {
      const done = isDayDone(d);
      if (d.rest) {
        return `
          <div class="day-block rest ${done ? "completed" : "incomplete"}">
            <div class="day-head">
              <span class="day-name">DESCANSO</span>
              <span class="day-count">${esc(d.title)}</span>
            </div>
          </div>`;
      }
      const exs = d.exercises.length
        ? d.exercises.map(exerciseHtml).join("")
        : `<div class="empty small">Sin ejercicios en este microciclo.</div>`;
      return `
        <div class="day-block ${done ? "completed" : "incomplete"}">
          <div class="day-head">
            <span class="day-name">${esc(d.title)}</span>
            <span class="day-count">${d.exercises.length} ejercicios</span>
          </div>
          ${exs}
        </div>`;
    })
    .join("");

  wrap.querySelectorAll(".ex-card").forEach((card) => {
    const toggle = card.querySelector(".ex-toggle");
    toggle.onclick = () => card.querySelector(".ex-body").classList.toggle("hidden");
    card.querySelector(".ex-save").onclick = () => saveExercise(card);
  });
}

/* ---------- guardar ---------- */

async function saveExercise(card) {
  const btn = card.querySelector(".ex-save");
  btn.disabled = true;
  try {
    const sets = [];
    card.querySelectorAll(".set-row").forEach((row) => {
      sets.push({
        kg: row.querySelector(".in-kg").value,
        reps: row.querySelector(".in-reps").value,
      });
    });
    const row = parseInt(card.dataset.row, 10);
    const res = await api("/api/save", {
      method: "POST",
      body: {
        entreno: state.entrenoKey,
        microIndex: state.microIndex,
        entries: [{ row, sets }],
      },
    });
    if (res.saved) {
      const sets2 = sets.map((s) => ({
        kg: s.kg === "" ? null : parseFloat(s.kg),
        reps: s.reps === "" ? null : parseFloat(s.reps),
      }));
      const text = sets2
        .filter((s) => s.kg !== null || s.reps !== null)
        .map((s) => {
          const kg = s.kg !== null ? `${fmtNum(s.kg)}kg` : "";
          const reps = s.reps !== null ? fmtNum(s.reps) : "";
          if (kg && reps) return `${kg} x ${reps}`;
          if (kg) return kg;
          return `${reps} reps`;
        })
        .join(" / ");
      state.records[recKey(state.entrenoKey, state.microIndex, row)] = text;
      card.querySelector(".ex-saved").innerHTML =
        `<span>Registrado: <b class="vals">${esc(text)}</b></span>`;
      renderWeeks();
      renderWeek();
      toast("Guardado ✓");
    } else {
      toast("Nada que guardar");
    }
  } catch (e) {
    toast(`Error: ${e.message}`);
  } finally {
    btn.disabled = false;
  }
}

/* ---------- chrome ---------- */

document.getElementById("btn-logout").onclick = async () => {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch (e) {}
  state.user = null;
  state.data = null;
  state.records = {};
  initGoogle._done = false;
  document.getElementById("gbtn").innerHTML = "";
  showLogin();
};

boot();

async function boot() {
  try {
    state.user = await api("/api/auth/me");
    await afterLogin();
  } catch (e) {
    showLogin();
  }
}
