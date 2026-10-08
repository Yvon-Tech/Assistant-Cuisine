'use strict';

/* ============================================================
   Assistant Cuisine IA — V1
   Tout est gardé en mémoire pendant la session (pas de base de données).
   ============================================================ */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  formUrl: '',
  mode: null,
  messages: [],      // { role:'user'|'assistant', text, ai?, block? }
  recipe: null,      // dernière recette (objet normalisé)
  owned: '',         // ingrédients que l'utilisateur dit posséder
  constraints: '',   // budget / temps / objectif de la demande initiale
  busy: false,
  error: null,
  lastRun: null,
  cook: { step: 0, done: false },
  shopping: null
};

/* ---------- Utilitaires de format ---------- */
function fmtNum(n) {
  if (n >= 10) return String(Math.round(n));
  let q = Math.round(n * 4) / 4;
  if (q === 0) q = 0.25;
  const w = Math.floor(q), f = q - w;
  const g = { 0: '', 0.25: '¼', 0.5: '½', 0.75: '¾' }[f];
  return (w ? String(w) : '') + (g ? (w ? ' ' : '') + g : '');
}
function qtyText(ing, factor) {
  if (ing.q == null) return ing.u || '';
  let q = ing.q * factor, u = ing.u || '';
  if (u === 'g' && q >= 1000) return (Math.round(q / 100) / 10).toString().replace('.', ',') + ' kg';
  if (u === 'ml' && q >= 1000) return (Math.round(q / 100) / 10).toString().replace('.', ',') + ' L';
  return fmtNum(q) + (u ? ' ' + u : '');
}
const fmtFcfa = n => Math.round(n / 25) * 25 === 0 ? '0 FCFA' : (Math.round(n / 25) * 25).toLocaleString('fr-FR') + ' FCFA';
function fmtClock(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = n => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}
function fmtDur(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const parts = [];
  if (h) parts.push(h + ' h');
  if (m) parts.push(m + ' min');
  if (s && !h) parts.push(s + ' s');
  return parts.join(' ') || '0 s';
}
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2800);
}

/* ---------- Navigation (compatible bouton retour du téléphone) ---------- */
let currentView = 'home';
function show(v) {
  if ((v === 'cook' || v === 'shopping') && !state.recipe) v = 'home';
  if (v === 'result' && !state.messages.length) v = 'home';
  currentView = v;
  $$('.view').forEach(el => el.classList.toggle('active', el.id === 'view-' + v));
  window.scrollTo(0, 0);
  if (v === 'cook') { lockScreen(); renderCook(); } else { unlockScreen(); }
  if (v === 'shopping') renderShopping();
}
function nav(v) {
  history.pushState({ v }, '', location.pathname);
  show(v);
}
history.replaceState({ v: 'home' }, '', location.pathname);
window.addEventListener('popstate', e => show((e.state && e.state.v) || 'home'));

/* ============================================================
   FORMULAIRES PAR MODE
   ============================================================ */
const GOALS = ['Repas léger', 'Nourrissant', 'Petit-déjeuner', 'Déjeuner', 'Dîner', 'Repas familial', 'Repas romantique', 'Repas économique', 'Repas pour étudiant', 'Repas pour invités'];
const DAYS = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];

function chipsHTML(name, label, options, { multi = false, selected = [], required = false, hint = '' } = {}) {
  const opts = options.map(o => Array.isArray(o) ? o : [o, o]);
  return `<fieldset class="field"><legend>${label}${hint ? ` <span class="hint">${hint}</span>` : ''}</legend>
    <div class="chips" data-group="${name}" data-multi="${multi}" data-required="${required}">
      ${opts.map(([v, l]) => `<button type="button" class="chip" data-v="${esc(v)}" aria-pressed="${selected.includes(v)}">${esc(l)}</button>`).join('')}
    </div></fieldset>`;
}
const textField = (id, label, ph, opt) => `<div class="field" data-field="${id}"><label for="f-${id}">${label}${opt ? ' <span class="hint">(facultatif)</span>' : ''}</label><input type="text" id="f-${id}" placeholder="${esc(ph)}" maxlength="300" autocomplete="off"></div>`;
const areaField = (id, label, ph, opt) => `<div class="field" data-field="${id}"><label for="f-${id}">${label}${opt ? ' <span class="hint">(facultatif)</span>' : ''}</label><textarea id="f-${id}" placeholder="${esc(ph)}" maxlength="600"></textarea></div>`;
const personsField = () => `<div class="field"><label for="f-persons">Nombre de personnes</label>
  <div class="stepper"><button type="button" data-step="-1" data-for="f-persons" aria-label="Moins de personnes">−</button>
  <input type="number" id="f-persons" inputmode="numeric" min="1" max="50" value="4"><button type="button" data-step="1" data-for="f-persons" aria-label="Plus de personnes">+</button></div></div>`;
const budgetField = (label, opt) => `<div class="field" data-field="budget"><label for="f-budget">${label}${opt ? ' <span class="hint">(facultatif)</span>' : ''}</label>
  <div class="input-suffix"><input type="number" id="f-budget" inputmode="numeric" min="0" step="100" placeholder="Ex : 2000"><span>FCFA</span></div></div>`;

const FIELDS = {
  dish: () => textField('dish', 'Quel plat veux-tu préparer ?', 'Ex : riz au poulet, amiwo, sauce gombo…'),
  dishOpt: () => textField('dishOpt', 'Une envie particulière ?', 'Ex : un plat avec du riz', true),
  ingredients: () => areaField('ingredients', 'Qu\'est-ce que tu as ?', 'Ex : deux œufs, du riz, des tomates, un oignon et du piment'),
  ingredientsOpt: () => areaField('ingredientsOpt', 'Ce que tu as déjà', 'Ex : des œufs, du riz', true),
  persons: personsField,
  budget: () => budgetField('Budget maximum', true),
  budgetReq: () => budgetField('Ton budget', false),
  budgetPlan: () => budgetField('Budget pour la période', true),
  time: () => chipsHTML('time', 'Temps disponible', [['15', '15 min'], ['30', '30 min'], ['45', '45 min'], ['60', '1 h']], { hint: '(facultatif)' }),
  minutes: () => chipsHTML('minutes', 'Combien de temps as-tu ?', [['10', '10 min'], ['15', '15 min'], ['20', '20 min'], ['30', '30 min'], ['45', '45 min']], { selected: ['20'], required: true }),
  level: () => chipsHTML('level', 'Ton niveau en cuisine', ['Débutant', 'Intermédiaire', 'Confirmé'], { hint: '(facultatif)' }),
  prefs: () => textField('prefs', 'Préférences particulières', 'Ex : peu de piment, pas de porc, végétarien…', true),
  goal: () => chipsHTML('goal', 'Objectif du repas', GOALS, { multi: true, hint: '(facultatif)' }),
  days: () => chipsHTML('days', 'Quels jours ?', DAYS, { multi: true, selected: DAYS }),
  meals: () => chipsHTML('meals', 'Quels repas ?', ['Petit-déjeuner', 'Déjeuner', 'Dîner'], { multi: true, selected: ['Déjeuner', 'Dîner'] })
};

const MODES = {
  prepare: {
    title: 'Je veux préparer', intro: 'Dis-moi le plat. Je te donne la recette complète.',
    fields: ['dish', 'persons', 'budget', 'time', 'level', 'prefs', 'goal'], submit: 'Générer la recette'
  },
  ingredients: {
    title: 'J\'ai des ingrédients', intro: 'Écris ce que tu as sous la main. Je te propose ce que tu peux cuisiner.',
    fields: ['ingredients', 'persons', 'time', 'goal'], submit: 'Trouver des recettes'
  },
  budget: {
    title: 'Petit budget', intro: 'Donne ton budget. Je cherche des recettes qui le respectent.',
    fields: ['budgetReq', 'persons', 'dishOpt', 'goal'], submit: 'Trouver des recettes'
  },
  rapide: {
    title: 'Je suis pressé', intro: 'Dis-moi le temps que tu as. Je propose des plats prêts à temps.',
    fields: ['minutes', 'persons', 'ingredientsOpt', 'goal'], submit: 'Trouver des recettes'
  },
  plan: {
    title: 'Planifier mes repas', intro: 'Choisis les jours et les repas. Je prépare le programme.',
    fields: ['days', 'meals', 'persons', 'budgetPlan', 'prefs'], submit: 'Créer mon programme'
  }
};

function openMode(mode) {
  state.mode = mode;
  const cfg = MODES[mode];
  $('#formTitle').textContent = cfg.title;
  $('#formIntro').textContent = cfg.intro;
  $('#modeFields').innerHTML = cfg.fields.map(f => FIELDS[f]()).join('');
  $('#formSubmit').textContent = cfg.submit;
  $('#formError').hidden = true;
  nav('form');
}

function groupValues(name) {
  return $$(`[data-group="${name}"] .chip[aria-pressed="true"]`).map(b => b.dataset.v);
}
const val = id => ($('#f-' + id) ? $('#f-' + id).value.trim() : '');

function formError(msg, focusSel) {
  const el = $('#formError');
  el.textContent = msg;
  el.hidden = false;
  const f = focusSel && $(focusSel);
  if (f) { f.focus(); const w = f.closest('.field'); if (w) w.classList.add('field-error'); }
}

function submitForm(e) {
  e.preventDefault();
  $$('.field-error').forEach(el => el.classList.remove('field-error'));
  $('#formError').hidden = true;
  const mode = state.mode;
  const persons = Math.min(50, Math.max(1, parseInt(val('persons'), 10) || 4));
  const goals = groupValues('goal');
  const goalTxt = goals.length ? ` Objectif du repas : ${goals.join(', ')}.` : '';
  let prompt = '', constraints = '';

  if (mode === 'prepare') {
    const dish = val('dish');
    if (!dish) return formError('Indique le plat que tu veux préparer.', '#f-dish');
    const budget = parseInt(val('budget'), 10), time = groupValues('time')[0], level = groupValues('level')[0], prefs = val('prefs');
    constraints = `Pour ${persons} personnes.` + (budget ? ` Budget maximum : ${budget} FCFA.` : '') + (time ? ` Temps maximum : ${time} minutes.` : '') + goalTxt;
    prompt = `Je veux préparer : ${dish}. Pour ${persons} personnes.` +
      (budget ? ` Budget maximum : ${budget} FCFA.` : '') +
      (time ? ` Temps disponible : ${time} minutes maximum.` : '') +
      (level ? ` Mon niveau en cuisine : ${level}.` : '') +
      (prefs ? ` Préférences : ${prefs}.` : '') + goalTxt +
      '\nRéponds avec une recette complète (type "recipe").';
    state.owned = '';
  } else if (mode === 'ingredients') {
    const ing = val('ingredients');
    if (!ing) return formError('Écris au moins un ingrédient.', '#f-ingredients');
    const time = groupValues('time')[0];
    state.owned = ing;
    constraints = `Pour ${persons} personnes.` + (time ? ` Temps maximum : ${time} minutes.` : '') + goalTxt;
    prompt = `J'ai ces ingrédients : ${ing}. C'est pour ${persons} personnes.` +
      (time ? ` Temps disponible : ${time} minutes maximum.` : '') + goalTxt +
      '\nPropose-moi 3 à 5 recettes réalisables (type "suggestions") avec, pour chacune, les ingrédients disponibles, manquants, remplaçables, la difficulté et le temps.';
  } else if (mode === 'budget') {
    const budget = parseInt(val('budget'), 10);
    if (!budget || budget <= 0) return formError('Indique ton budget en FCFA.', '#f-budget');
    const envie = val('dishOpt');
    state.owned = '';
    constraints = `Pour ${persons} personnes. Budget maximum : ${budget} FCFA.` + goalTxt;
    prompt = `Je veux préparer quelque chose pour ${persons} personnes avec ${budget} FCFA.` +
      (envie ? ` Envie : ${envie}.` : '') + goalTxt +
      '\nPropose-moi 3 à 5 recettes qui respectent ce budget (type "suggestions"), avec une estimation du coût total en FCFA pour chacune.';
  } else if (mode === 'rapide') {
    const min = groupValues('minutes')[0] || '20';
    const have = val('ingredientsOpt');
    state.owned = have;
    constraints = `Pour ${persons} personnes. Temps maximum : ${min} minutes (préparation et cuisson comprises).` + goalTxt;
    prompt = `J'ai seulement ${min} minutes, pour ${persons} personnes.` + (have ? ` J'ai : ${have}.` : '') + goalTxt +
      `\nPropose-moi 3 à 5 recettes réalisables en ${min} minutes maximum, préparation et cuisson comprises (type "suggestions").`;
  } else if (mode === 'plan') {
    const days = groupValues('days'), meals = groupValues('meals');
    if (!days.length) return formError('Choisis au moins un jour.', '[data-group="days"] .chip');
    if (!meals.length) return formError('Choisis au moins un repas.', '[data-group="meals"] .chip');
    const budget = parseInt(val('budget'), 10), prefs = val('prefs');
    state.owned = '';
    constraints = `Pour ${persons} personnes.` + (budget ? ` Budget total : ${budget} FCFA.` : '') + (prefs ? ` Préférences : ${prefs}.` : '');
    prompt = `Prépare-moi un programme de repas (${meals.join(' et ').toLowerCase()}) pour ${days.join(', ')}, pour ${persons} personnes.` +
      (budget ? ` Budget total : ${budget} FCFA.` : '') + (prefs ? ` Préférences : ${prefs}.` : '') +
      '\nRéponds avec un programme (type "plan").';
  }

  // Nouvelle conversation
  state.messages = [{ role: 'user', text: prompt.split('\n')[0], ai: prompt }];
  state.recipe = null;
  state.constraints = constraints;
  state.shopping = null;
  resetCookSession();
  $('#resultTitle').textContent = MODES[mode].title;
  nav('result');
  run(prompt);
}

/* ============================================================
   APPEL À L'IA
   ============================================================ */
function normRecipe(r) {
  r = r || {};
  const num = v => (v === null || v === undefined || v === '' || !isFinite(+v)) ? null : +v;
  const strs = a => (Array.isArray(a) ? a : []).map(x => String(x || '').trim()).filter(Boolean);
  const rec = {
    nom: String(r.nom || 'Recette'),
    personnes: Math.max(1, Math.round(num(r.personnes) || 4)),
    prep: num(r.temps_preparation_min),
    cuisson: num(r.temps_cuisson_min),
    difficulte: String(r.difficulte || ''),
    cout: num(r.cout_total_fcfa),
    ingredients: (Array.isArray(r.ingredients) ? r.ingredients : []).map(i => ({
      nom: String((i && i.nom) || '').trim(), q: num(i && i.quantite), u: String((i && i.unite) || ''),
      condiment: !!(i && i.condiment), dispo: !!(i && i.disponible === true), cout: num(i && i.cout_fcfa)
    })).filter(i => i.nom),
    materiel: strs(r.materiel),
    etapes: (Array.isArray(r.etapes) ? r.etapes : []).map(e => {
      if (typeof e === 'string') return { texte: e, sec: null, label: '' };
      const s = num(e && e.minuteur_secondes);
      return { texte: String((e && e.texte) || '').trim(), sec: s && s > 0 ? Math.round(s) : null, label: String((e && e.minuteur_label) || '') };
    }).filter(e => e.texte),
    conseils: strs(r.conseils)
  };
  rec.persons = rec.personnes;
  return rec;
}

// Version « brute » (quantités déjà recalculées) envoyée à l'IA comme contexte
function recipeForAI(rec) {
  const f = rec.persons / rec.personnes;
  return {
    nom: rec.nom, personnes: rec.persons,
    temps_preparation_min: rec.prep, temps_cuisson_min: rec.cuisson, difficulte: rec.difficulte,
    cout_total_fcfa: rec.cout != null ? Math.round(rec.cout * f) : null,
    ingredients: rec.ingredients.map(i => ({
      nom: i.nom, quantite: i.q != null ? Math.round(i.q * f * 100) / 100 : null, unite: i.u, condiment: i.condiment,
      disponible: i.dispo ? true : null, cout_fcfa: i.cout != null ? Math.round(i.cout * f) : null
    })),
    materiel: rec.materiel,
    etapes: rec.etapes.map(e => ({ texte: e.texte, minuteur_secondes: e.sec, minuteur_label: e.label || null })),
    conseils: rec.conseils
  };
}

function handleAI(d) {
  const msg = { role: 'assistant', text: String(d.message || '') };
  if (d.type === 'recipe' && d.recipe) {
    const rec = normRecipe(d.recipe);
    if (rec.etapes.length || rec.ingredients.length) {
      msg.block = { type: 'recipe', rec };
      state.recipe = rec;
      state.shopping = null;
      resetCookSession();
    }
  } else if (d.type === 'suggestions' && Array.isArray(d.suggestions)) {
    const arr = a => (Array.isArray(a) ? a : []).map(x => String(x || '').trim()).filter(Boolean);
    msg.block = {
      type: 'suggestions',
      items: d.suggestions.map(s => ({
        nom: String(s.nom || 'Recette'), resume: String(s.resume || ''), personnes: Number(s.personnes) || null,
        difficulte: String(s.difficulte || ''), temps: Number(s.temps_minutes) || null,
        dispo: arr(s.disponibles), manque: arr(s.manquants),
        remplacables: (Array.isArray(s.remplacables) ? s.remplacables : []).filter(x => x && x.manquant).map(x => ({ m: String(x.manquant), r: String(x.remplacement || '') })),
        cout: Number(s.cout_total_fcfa) || null
      })).filter(s => s.nom)
    };
  } else if (d.type === 'plan' && d.plan && Array.isArray(d.plan.jours)) {
    msg.block = {
      type: 'plan',
      personnes: Number(d.plan.personnes) || 4,
      jours: d.plan.jours.map(j => ({ jour: String(j.jour || ''), pd: j.petit_dejeuner || null, d: j.dejeuner || null, s: j.diner || null }))
    };
  } else if (d.type === 'courses' && Array.isArray(d.courses)) {
    msg.block = {
      type: 'courses',
      items: d.courses.map(c => ({ nom: String(c.nom || ''), q: (c.quantite == null || !isFinite(+c.quantite)) ? null : +c.quantite, u: String(c.unite || ''), checked: false })).filter(c => c.nom)
    };
  }
  if (!msg.text && !msg.block) msg.text = 'Je n\'ai pas bien compris. Peux-tu reformuler ?';
  state.messages.push(msg);
}

function historyForAI() {
  return state.messages.slice(0, -1).slice(-10).map(m => {
    if (m.role === 'user') return { role: 'user', text: m.ai || m.text };
    let t = m.text || '';
    if (m.block && m.block.type === 'recipe') t += ` [Recette proposée : ${m.block.rec.nom}]`;
    if (m.block && m.block.type === 'suggestions') t += ' [Propositions : ' + m.block.items.map(i => i.nom).join(', ') + ']';
    if (m.block && m.block.type === 'plan') t += ' [Programme de repas proposé]';
    return { role: 'assistant', text: t.trim() || '…' };
  });
}

async function run(text) {
  state.busy = true;
  state.error = null;
  state.lastRun = text;
  renderThread();
  scrollToEnd();
  try {
    const res = await fetch('/api/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, history: historyForAI(), recipe: state.recipe ? recipeForAI(state.recipe) : null })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Une erreur est survenue.');
    handleAI(data);
    state.busy = false;
    renderThread();
    const last = $('#thread').lastElementChild;
    if (last) last.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    state.busy = false;
    state.error = (err && err.message && err.message !== 'Failed to fetch') ? err.message : 'Impossible de joindre le serveur. Vérifie que l\'application est bien lancée.';
    renderThread();
    scrollToEnd();
  }
}

function send(text, display) {
  if (state.busy) return;
  state.messages.push({ role: 'user', text: display || text, ai: text });
  run(text);
}
function scrollToEnd() {
  const t = $('#thread');
  if (t && t.lastElementChild) t.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

/* ============================================================
   RENDU DE LA DISCUSSION
   ============================================================ */
function metaItems(rec) {
  const f = rec.persons / rec.personnes;
  const m = [];
  if (rec.prep != null) m.push(`🔪 Préparation ${fmtDur(rec.prep * 60)}`);
  if (rec.cuisson != null) m.push(`🔥 Cuisson ${fmtDur(rec.cuisson * 60)}`);
  if (rec.difficulte) m.push(`Difficulté : ${esc(rec.difficulte)}`);
  if (rec.cout != null) m.push(`💰 ≈ ${fmtFcfa(rec.cout * f)}`);
  return m.map(x => `<li>${x}</li>`).join('');
}

function ingLine(i, f) {
  return `<li><span>${esc(i.nom)}${i.dispo ? ' <span class="ing-dispo">✓ tu l\'as</span>' : ''}</span>
    <span class="q">${esc(qtyText(i, f))}${i.cout != null ? `<span class="price">≈ ${fmtFcfa(i.cout * f)}</span>` : ''}</span></li>`;
}

function recipeCard(rec) {
  const f = rec.persons / rec.personnes;
  const main = rec.ingredients.filter(i => !i.condiment), cond = rec.ingredients.filter(i => i.condiment);
  const hasCost = rec.cout != null || rec.ingredients.some(i => i.cout != null);
  return `<article class="recipe" data-recipe>
    <h2>${esc(rec.nom)}</h2>
    <ul class="meta">${metaItems(rec)}</ul>
    <div class="persons"><span>Pour</span>
      <div class="stepper"><button type="button" data-act="persons-minus" aria-label="Moins de personnes">−</button><output aria-live="polite">${rec.persons}</output><button type="button" data-act="persons-plus" aria-label="Plus de personnes">+</button></div>
      <span>personne${rec.persons > 1 ? 's' : ''}</span></div>
    ${rec.persons !== rec.personnes ? '<p class="note">Les quantités sont recalculées. Surveille la cuisson : les temps peuvent varier.</p>' : ''}
    ${main.length ? `<h3>Ingrédients</h3><ul class="ings">${main.map(i => ingLine(i, f)).join('')}</ul>` : ''}
    ${cond.length ? `<h3>Condiments</h3><ul class="ings">${cond.map(i => ingLine(i, f)).join('')}</ul>` : ''}
    ${hasCost ? '<p class="note">Prix indicatifs : ils varient selon le marché.</p>' : ''}
    ${rec.materiel.length ? `<h3>Matériel</h3><ul class="plain">${rec.materiel.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${rec.etapes.length ? `<h3>Étapes</h3><ol class="steps">${rec.etapes.map(e => `<li><span>${esc(e.texte)}${e.sec ? `<span class="chip-timer">⏱ ${fmtDur(e.sec)}</span>` : ''}</span></li>`).join('')}</ol>` : ''}
    ${rec.conseils.length ? `<h3>Conseils et astuces</h3><ul class="tips">${rec.conseils.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    <div class="recipe-actions">
      ${rec.etapes.length ? '<button type="button" class="btn btn-primary btn-big" data-act="cook">Lancer le mode cuisine</button>' : ''}
      <button type="button" class="btn btn-secondary" data-act="shopping">🛒 Liste de courses</button>
    </div>
  </article>`;
}

function suggestionsHTML(block, mi) {
  return `<div class="sugg-list">${block.items.map((s, si) => {
    const meta = [];
    if (s.temps) meta.push(`⏱ ${fmtDur(s.temps * 60)}`);
    if (s.difficulte) meta.push(`Difficulté : ${esc(s.difficulte)}`);
    if (s.personnes) meta.push(`${s.personnes} pers.`);
    if (s.cout) meta.push(`💰 ≈ ${fmtFcfa(s.cout)}`);
    return `<article class="sugg"><h3>${esc(s.nom)}</h3>
      ${s.resume ? `<p class="muted">${esc(s.resume)}</p>` : ''}
      ${meta.length ? `<ul class="meta">${meta.map(x => `<li>${x}</li>`).join('')}</ul>` : ''}
      <dl>
        ${s.dispo.length ? `<div><dt>Tu as : </dt><dd>${esc(s.dispo.join(', '))}</dd></div>` : ''}
        ${s.manque.length ? `<div><dt>Il te manque : </dt><dd>${esc(s.manque.join(', '))}</dd></div>` : ''}
        ${s.remplacables.length ? `<div><dt>Remplaçable : </dt><dd>${esc(s.remplacables.map(x => x.r ? `${x.m} par ${x.r}` : x.m).join(', '))}</dd></div>` : ''}
      </dl>
      <button type="button" class="btn btn-secondary" data-act="pick" data-m="${mi}" data-s="${si}">Choisir cette recette</button>
    </article>`;
  }).join('')}</div>`;
}

function planHTML(block, mi) {
  const hasPd = block.jours.some(j => j.pd);
  const cell = (j, di, k, v) => v ? `<td><button type="button" class="meal" data-act="meal" data-m="${mi}" data-d="${di}" data-k="${k}">${esc(v)}</button></td>` : '<td>—</td>';
  return `<div class="plan"><div class="table-scroll"><table>
    <thead><tr><th>Jour</th>${hasPd ? '<th>Petit-déj.</th>' : ''}<th>Déjeuner</th><th>Dîner</th></tr></thead>
    <tbody>${block.jours.map((j, di) => `<tr><td>${esc(j.jour)}</td>${hasPd ? cell(j, di, 'pd', j.pd) : ''}${cell(j, di, 'd', j.d)}${cell(j, di, 's', j.s)}</tr>`).join('')}</tbody></table></div>
    <p class="note">Touche un plat pour obtenir sa recette.</p>
    <button type="button" class="btn btn-secondary" data-act="plan-courses" data-m="${mi}">🛒 Liste de courses globale</button></div>`;
}

function coursesHTML(block, mi) {
  return `<div class="courses"><h3>Liste de courses</h3><ul>${block.items.map((c, ci) => {
    const q = c.q != null ? fmtNum(c.q) + (c.u ? ' ' + c.u : '') : (c.u || '');
    return `<li class="${c.checked ? 'done' : ''}"><label class="check"><input type="checkbox" data-course data-m="${mi}" data-i="${ci}" ${c.checked ? 'checked' : ''}><span>${esc(c.nom)}</span></label><span class="qty">${esc(q)}</span></li>`;
  }).join('')}</ul></div>`;
}

function renderThread() {
  let lastRecipe = -1;
  state.messages.forEach((m, i) => { if (m.block && m.block.type === 'recipe') lastRecipe = i; });
  let html = state.messages.map((m, i) => {
    if (m.role === 'user') return `<div class="msg user"><p>${esc(m.text)}</p></div>`;
    let inner = m.text ? `<p>${esc(m.text)}</p>` : '';
    const b = m.block;
    if (b) {
      if (b.type === 'recipe') inner += i === lastRecipe ? recipeCard(b.rec) : `<p class="old-version">Version précédente : ${esc(b.rec.nom)} (${b.rec.persons} pers.)</p>`;
      else if (b.type === 'suggestions') inner += suggestionsHTML(b, i);
      else if (b.type === 'plan') inner += planHTML(b, i);
      else if (b.type === 'courses') inner += coursesHTML(b, i);
    }
    return `<div class="msg bot">${inner}</div>`;
  }).join('');
  if (state.busy) html += '<div class="msg bot"><p><span class="dots" role="status" aria-label="L\'assistant réfléchit"><i></i><i></i><i></i></span></p></div>';
  if (state.error) html += `<div class="msg bot"><div class="error-box" role="alert"><span>${esc(state.error)}</span><button type="button" class="btn btn-secondary" data-act="retry">Réessayer</button></div></div>`;
  $('#thread').innerHTML = html;
  $('#quick').hidden = !state.recipe || state.busy;
  $('#composer .send').disabled = state.busy;
}

function refreshRecipeCard(focusAct) {
  const el = $('[data-recipe]');
  if (!el || !state.recipe) return;
  el.outerHTML = recipeCard(state.recipe);
  const b = focusAct && $(`[data-act="${focusAct}"]`);
  if (b) b.focus({ preventScroll: true });
}

/* ============================================================
   LISTE DE COURSES (recette)
   ============================================================ */
function openShopping() {
  const rec = state.recipe;
  if (!rec) return;
  const f = rec.persons / rec.personnes;
  state.shopping = {
    nom: rec.nom,
    items: rec.ingredients.map(i => ({ nom: i.nom, qty: qtyText(i, f), cout: i.cout != null ? i.cout * f : null, owned: i.dispo, checked: false }))
  };
  nav('shopping');
}

function renderShopping() {
  const sh = state.shopping, root = $('#shopRoot');
  if (!sh) { root.innerHTML = ''; return; }
  const buy = sh.items.map((x, i) => ({ x, i })).filter(o => !o.x.owned);
  const have = sh.items.map((x, i) => ({ x, i })).filter(o => o.x.owned);
  const inCart = buy.filter(o => o.x.checked).length;
  const cost = buy.reduce((s, o) => s + (o.x.cout || 0), 0);
  const row = (o, owned) => `<li class="${o.x.checked && !owned ? 'done' : ''}">
    ${owned ? `<span class="check"><span>✓ ${esc(o.x.nom)}</span></span>` : `<label class="check"><input type="checkbox" data-sh="${o.i}" ${o.x.checked ? 'checked' : ''}><span>${esc(o.x.nom)}</span></label>`}
    <span class="qty">${esc(o.x.qty)}</span>
    <button type="button" class="link" data-act="sh-toggle" data-i="${o.i}">${owned ? 'Il me manque' : 'Je l\'ai déjà'}</button></li>`;
  root.innerHTML = `<p class="shop-summary"><strong>${esc(sh.nom)}</strong><br>${buy.length} à acheter${buy.length ? ` · ${inCart} dans le panier` : ''}${cost ? ` · ≈ ${fmtFcfa(cost)}` : ''}</p>
    <section class="shop-section"><h2>À acheter</h2>${buy.length ? `<ul class="shop-list">${buy.map(o => row(o, false)).join('')}</ul>` : '<p class="empty">Tout est déjà disponible.</p>'}</section>
    <section class="shop-section owned"><h2>Disponible</h2>${have.length ? `<ul class="shop-list">${have.map(o => row(o, true)).join('')}</ul>` : '<p class="empty">Rien pour l\'instant. Touche « Je l\'ai déjà » pour déplacer un ingrédient ici.</p>'}</section>
    <button type="button" class="btn btn-secondary btn-big" data-act="share-list">Partager la liste à acheter</button>`;
}

async function shareList() {
  const sh = state.shopping;
  if (!sh) return;
  const lines = sh.items.filter(x => !x.owned).map(x => `- ${x.nom}${x.qty ? ' : ' + x.qty : ''}`);
  const text = `Courses pour ${sh.nom}\n` + lines.join('\n');
  try {
    if (navigator.share) { await navigator.share({ title: 'Liste de courses', text }); return; }
    await navigator.clipboard.writeText(text);
    toast('Liste copiée');
  } catch (e) { /* partage annulé */ }
}

/* ============================================================
   CHRONOMÈTRES + SONNERIE
   ============================================================ */
const timers = new Map();   // id -> { id, step, label, total, left, endAt, st }
const ringing = new Set();
let ringOn = false, audioEl = null, audioUnlocked = false, actx = null, beepTimer = null;

function getAudio() {
  if (!audioEl) {
    audioEl = new Audio('assets/sonnerie.mp3');
    audioEl.loop = true;
    audioEl.preload = 'auto';
  }
  return audioEl;
}
// Les navigateurs exigent un geste de l'utilisateur avant de jouer un son : on « débloque » à l'appui sur Démarrer.
function unlockAudio() {
  try {
    if (!actx) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) actx = new AC(); }
    if (actx && actx.state === 'suspended') actx.resume();
    if (!audioUnlocked) {
      const a = getAudio();
      a.muted = true;
      const p = a.play();
      if (p && p.then) p.then(() => { a.pause(); a.currentTime = 0; a.muted = false; audioUnlocked = true; }).catch(() => { a.muted = false; });
    }
  } catch (e) { /* ignore */ }
}
function startBeep() {
  if (beepTimer || !ringOn || !actx) return;
  const beep = () => {
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = 'sine'; o.frequency.value = 880; g.gain.value = 0.2;
    o.connect(g); g.connect(actx.destination);
    o.start(); o.stop(actx.currentTime + 0.25);
  };
  beep();
  beepTimer = setInterval(beep, 700);
}
function startRing() {
  if (ringOn) return;
  ringOn = true;
  if (navigator.vibrate) navigator.vibrate([400, 200, 400, 200, 400]);
  const a = getAudio();
  a.muted = false;
  a.currentTime = 0;
  const p = a.play();
  if (p && p.catch) p.catch(startBeep);   // fichier absent ou bloqué : simple bip de secours
}
function stopRing() {
  ringOn = false;
  clearInterval(beepTimer); beepTimer = null;
  if (audioEl) { audioEl.pause(); audioEl.currentTime = 0; }
  if (navigator.vibrate) navigator.vibrate(0);
  ringing.clear();
  $('#alarm').hidden = true;
  if (currentView === 'cook') renderCook();
}
function showAlarm() {
  const names = Array.from(ringing).map(id => timers.get(id)).filter(Boolean).map(t => t.label);
  $('#alarmText').textContent = '⏰ ' + (names.length ? names.join(' + ') + ' : terminé !' : 'Minuteur terminé !');
  $('#alarm').hidden = false;
}

function resetCookSession() {
  timers.clear();
  ringing.clear();
  if (ringOn) stopRing();
  state.cook = { step: 0, done: false };
}
function getTimer(i) {
  const s = state.recipe.etapes[i];
  const id = 's' + i;
  if (!timers.has(id)) timers.set(id, { id, step: i, label: s.label || `Étape ${i + 1}`, total: s.sec, left: s.sec, endAt: 0, st: 'idle' });
  return timers.get(id);
}
function timerStart(id) {
  unlockAudio();
  const t = timers.get(id);
  if (!t) return;
  if (t.st === 'done' || t.left <= 0) t.left = t.total;
  ringing.delete(id);
  t.endAt = Date.now() + t.left * 1000;
  t.st = 'running';
}
function timerPause(id) {
  const t = timers.get(id);
  if (!t || t.st !== 'running') return;
  t.left = Math.max(0, Math.ceil((t.endAt - Date.now()) / 1000));
  t.st = 'paused';
}
function timerReset(id) {
  const t = timers.get(id);
  if (!t) return;
  t.left = t.total; t.st = 'idle';
  ringing.delete(id);
  if (!ringing.size && ringOn) stopRing();
}
function paintTimer(t) {
  $$(`[data-tt="${t.id}"]`).forEach(el => { el.textContent = fmtClock(t.left); });
  $$(`[data-tr="${t.id}"]`).forEach(el => { el.style.strokeDashoffset = String(339.292 * (1 - t.left / t.total)); });
}
setInterval(() => {
  let finished = false;
  const now = Date.now();
  timers.forEach(t => {
    if (t.st !== 'running') return;
    const left = Math.max(0, Math.ceil((t.endAt - now) / 1000));
    if (left !== t.left) { t.left = left; paintTimer(t); }
    if (left <= 0) { t.st = 'done'; ringing.add(t.id); finished = true; }
  });
  if (finished) {
    startRing();
    showAlarm();
    if (currentView === 'cook') renderCook();
  }
}, 250);

/* ---------- Écran de veille ---------- */
let wake = null;
async function lockScreen() { try { if ('wakeLock' in navigator && !wake) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); } } catch (e) { /* ignore */ } }
function unlockScreen() { if (wake) { wake.release().catch(() => {}); wake = null; } }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && currentView === 'cook') lockScreen(); });

/* ============================================================
   MODE CUISINE
   ============================================================ */
function timerControls(t, big) {
  const cls = big ? 'btn' : '';
  if (t.st === 'idle') return `<button type="button" class="${cls} btn-start" data-act="t-start" data-id="${t.id}">▶ Démarrer</button>`;
  if (t.st === 'running') return `<button type="button" class="${cls} btn-outline" data-act="t-pause" data-id="${t.id}">⏸ Pause</button><button type="button" class="${cls} btn-outline" data-act="t-reset" data-id="${t.id}">↺ Remettre à zéro</button>`;
  if (t.st === 'paused') return `<button type="button" class="${cls} btn-start" data-act="t-start" data-id="${t.id}">▶ Reprendre</button><button type="button" class="${cls} btn-outline" data-act="t-reset" data-id="${t.id}">↺ Remettre à zéro</button>`;
  return `<button type="button" class="${cls} btn-start" data-act="t-start" data-id="${t.id}">↺ Relancer</button>`;
}

function renderCook() {
  const root = $('#cookRoot');
  const rec = state.recipe;
  if (!rec) { root.innerHTML = ''; return; }
  const total = rec.etapes.length;

  if (state.cook.done) {
    root.innerHTML = `<div class="cook"><div class="cook-top"><button type="button" class="icon-btn" data-act="cook-exit" aria-label="Quitter le mode cuisine">✕</button></div>
      <div class="finish"><h2>Bon appétit&nbsp;!</h2><p>${esc(rec.nom)} est prêt. Dis-nous si l'assistant t'a été utile.</p>
      <button type="button" class="btn btn-start" data-act="feedback">⭐ Donner mon avis</button>
      <button type="button" class="btn btn-outline" data-act="cook-exit">Retour à la recette</button></div></div>`;
    return;
  }

  const i = state.cook.step, step = rec.etapes[i];
  const f = rec.persons / rec.personnes;
  let timerHTML = '';
  if (step.sec) {
    const t = getTimer(i);
    const offset = 339.292 * (1 - t.left / t.total);
    timerHTML = `<div class="timer ${t.st}">
      <div class="ring"><svg viewBox="0 0 120 120" aria-hidden="true"><circle class="ring-bg" cx="60" cy="60" r="54"/><circle class="ring-fg" data-tr="${t.id}" cx="60" cy="60" r="54" style="stroke-dashoffset:${offset}"/></svg>
      <span class="digits" data-tt="${t.id}" role="timer">${fmtClock(t.left)}</span></div>
      <p class="timer-label">${esc(t.label)}</p>
      <div class="timer-actions">${timerControls(t, true)}</div></div>`;
  }
  const others = Array.from(timers.values()).filter(t => t.st !== 'idle' && t.step !== i);
  const dock = others.length ? `<div class="dock" aria-label="Autres minuteurs">${others.map(t => `<div class="dock-item ${t.st}">
      <div class="label">${esc(t.label)}<small>Étape ${t.step + 1}</small></div>
      <span class="dock-time" data-tt="${t.id}">${fmtClock(t.left)}</span>
      ${t.st === 'running' ? `<button type="button" data-act="t-pause" data-id="${t.id}" aria-label="Pause">⏸</button>` : t.st === 'paused' ? `<button type="button" data-act="t-start" data-id="${t.id}" aria-label="Reprendre">▶</button>` : `<button type="button" data-act="t-start" data-id="${t.id}" aria-label="Relancer">↺</button>`}
    </div>`).join('')}</div>` : '';

  root.innerHTML = `<div class="cook">
    <div class="cook-top">
      <button type="button" class="icon-btn" data-act="cook-exit" aria-label="Quitter le mode cuisine">✕</button>
      <div class="cook-progress"><span>Étape ${i + 1} sur ${total}</span><div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${i + 1}"><i style="width:${((i + 1) / total) * 100}%"></i></div></div>
    </div>
    <details class="cook-ings"><summary>Ingrédients (${rec.persons} pers.)</summary><ul>${rec.ingredients.map(g => `<li><span>${esc(g.nom)}</span><strong>${esc(qtyText(g, f))}</strong></li>`).join('')}</ul></details>
    <div class="cook-body"><p class="cook-step">${esc(step.texte)}</p>${timerHTML}</div>
    ${dock}
    <div class="cook-actions">
      ${i > 0 ? '<button type="button" class="btn btn-ghost" data-act="cook-prev" aria-label="Étape précédente">←</button>' : ''}
      <button type="button" class="btn btn-next" data-act="cook-next">${i === total - 1 ? '✓ Terminer' : '✓ J\'ai terminé'}</button>
    </div></div>`;
}

function startCook() {
  if (!state.recipe || !state.recipe.etapes.length) return;
  resetCookSession();
  nav('cook');
}

/* ============================================================
   AVIS (Google Forms)
   ============================================================ */
function openFeedback() {
  if (state.formUrl) window.open(state.formUrl, '_blank', 'noopener');
  else toast('Le lien du formulaire n\'est pas encore configuré.');
}

/* ============================================================
   ÉVÉNEMENTS
   ============================================================ */
document.addEventListener('click', e => {
  // Tuiles de l'accueil
  const tile = e.target.closest('[data-mode]');
  if (tile) { openMode(tile.dataset.mode); return; }

  // Pastilles (formulaires)
  const chip = e.target.closest('.chips .chip');
  if (chip) {
    const grp = chip.parentElement;
    const multi = grp.dataset.multi === 'true', req = grp.dataset.required === 'true';
    const on = chip.getAttribute('aria-pressed') === 'true';
    if (multi) chip.setAttribute('aria-pressed', String(!on));
    else if (on) { if (!req) chip.setAttribute('aria-pressed', 'false'); }
    else { $$('.chip', grp).forEach(c => c.setAttribute('aria-pressed', 'false')); chip.setAttribute('aria-pressed', 'true'); }
    return;
  }

  // Boutons + / − du formulaire
  const stepBtn = e.target.closest('[data-step]');
  if (stepBtn) {
    const inp = $('#' + stepBtn.dataset.for);
    inp.value = Math.min(50, Math.max(1, (parseInt(inp.value, 10) || 1) + parseInt(stepBtn.dataset.step, 10)));
    return;
  }

  // Suggestions rapides de modification
  const q = e.target.closest('[data-q]');
  if (q) { send(q.dataset.q); return; }

  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  switch (act) {
    case 'back': history.back(); break;
    case 'home': nav('home'); break;
    case 'feedback': openFeedback(); break;
    case 'retry': if (state.lastRun) run(state.lastRun); break;
    case 'persons-plus':
    case 'persons-minus':
      if (state.recipe) {
        state.recipe.persons = Math.min(50, Math.max(1, state.recipe.persons + (act === 'persons-plus' ? 1 : -1)));
        refreshRecipeCard(act);
      }
      break;
    case 'cook': startCook(); break;
    case 'shopping': openShopping(); break;
    case 'pick': {
      const blk = state.messages[+el.dataset.m].block;
      const s = blk && blk.items[+el.dataset.s];
      if (!s) break;
      const n = s.personnes || 4;
      const txt = `Je choisis « ${s.nom} » pour ${n} personnes. Donne-moi la recette complète (type "recipe").` +
        (state.constraints ? ` Contraintes de départ : ${state.constraints}` : '') +
        (state.owned ? ` Ingrédients que j'ai : ${state.owned}. Mets "disponible": true pour ceux que j'ai déjà.` : '');
      send(txt, `Je choisis : ${s.nom}`);
      break;
    }
    case 'meal': {
      const blk = state.messages[+el.dataset.m].block;
      const j = blk && blk.jours[+el.dataset.d];
      if (!j) break;
      const plat = j[el.dataset.k];
      send(`Donne-moi la recette complète de « ${plat} » pour ${blk.personnes} personnes (type "recipe").` + (state.constraints ? ` Contraintes générales : ${state.constraints}` : ''), `Recette : ${plat}`);
      break;
    }
    case 'plan-courses': {
      const blk = state.messages[+el.dataset.m].block;
      if (!blk) break;
      const lignes = blk.jours.map(j => `${j.jour} : ${[j.pd && 'petit-déjeuner ' + j.pd, j.d && 'déjeuner ' + j.d, j.s && 'dîner ' + j.s].filter(Boolean).join(', ')}`).join('\n');
      send(`Voici mon programme de repas pour ${blk.personnes} personnes :\n${lignes}\nDonne-moi la liste de courses globale, regroupée (type "courses").`, 'Liste de courses globale');
      break;
    }
    case 'cook-exit': history.back(); break;
    case 'cook-prev': if (state.cook.step > 0) { state.cook.step--; renderCook(); window.scrollTo(0, 0); } break;
    case 'cook-next':
      if (state.cook.step >= state.recipe.etapes.length - 1) state.cook.done = true;
      else state.cook.step++;
      renderCook();
      window.scrollTo(0, 0);
      break;
    case 't-start': timerStart(el.dataset.id); if (!ringing.size) { if (ringOn) stopRing(); else $('#alarm').hidden = true; } else showAlarm(); renderCook(); break;
    case 't-pause': timerPause(el.dataset.id); renderCook(); break;
    case 't-reset': timerReset(el.dataset.id); if (!ringing.size) $('#alarm').hidden = true; else showAlarm(); renderCook(); break;
    case 'stop-ring': stopRing(); break;
    case 'sh-toggle': {
      const it = state.shopping && state.shopping.items[+el.dataset.i];
      if (it) { it.owned = !it.owned; it.checked = false; renderShopping(); }
      break;
    }
    case 'share-list': shareList(); break;
  }
});

document.addEventListener('change', e => {
  const c = e.target.closest('[data-course]');
  if (c) {
    const blk = state.messages[+c.dataset.m].block;
    if (blk && blk.items[+c.dataset.i]) {
      blk.items[+c.dataset.i].checked = c.checked;
      c.closest('li').classList.toggle('done', c.checked);
    }
    return;
  }
  const s = e.target.closest('[data-sh]');
  if (s && state.shopping) {
    state.shopping.items[+s.dataset.sh].checked = s.checked;
    renderShopping();
  }
});

$('#modeForm').addEventListener('submit', submitForm);
$('#composer').addEventListener('submit', e => {
  e.preventDefault();
  const inp = $('#composerInput');
  const text = inp.value.trim();
  if (!text || state.busy) return;
  inp.value = '';
  send(text);
});

// Lien du formulaire d'avis (défini côté serveur dans le fichier .env)
fetch('/api/config').then(r => r.json()).then(c => { state.formUrl = c.formUrl || ''; }).catch(() => {});
