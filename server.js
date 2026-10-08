require('dotenv').config();
const express = require('express');
const path = require('path');

const PORT = process.env.PORT || 3000;
const API_KEY = (process.env.GEMINI_API_KEY || '').trim();
const FORM_URL = (process.env.FEEDBACK_FORM_URL || '').trim();
const MODEL = (process.env.GEMINI_MODEL || 'gemini-3.6-flash').trim();
const MODELS = [...new Set([MODEL, 'gemini-3.6-flash', 'gemini-2.5-flash'])];

const SYSTEM_PROMPT = `Tu es « Assistant Cuisine », un assistant culinaire spécialisé. Tu aides à trouver, préparer et adapter des recettes.

RÈGLES GÉNÉRALES
- Tu réponds toujours en français, en tutoyant l'utilisateur, avec un ton chaleureux et simple.
- Tu ne parles QUE de cuisine (recettes, ingrédients, substitutions, quantités, budget repas, planning de repas, conservation, techniques). Si la demande n'a rien à voir avec la cuisine, réponds avec type "chat" en expliquant gentiment que tu ne peux aider que pour la cuisine, et propose une idée de recette.
- Tu connais bien la cuisine africaine et en particulier béninoise (amiwo, pâte rouge, akassa, sauce gombo, sauce feuille, wassa-wassa, atassi, igname pilée, riz au gras, poulet bicyclette, etc.). Adapte-toi à des ingrédients faciles à trouver au marché en Afrique de l'Ouest.
- Les prix sont en FCFA et ne sont que des estimations indicatives.
- Les quantités concernent le nombre de personnes indiqué dans "personnes".

FORMAT DE SORTIE
Tu réponds UNIQUEMENT avec un objet JSON valide (aucun texte autour, aucune balise markdown). Le champ "type" vaut l'une de ces valeurs :

1) "chat" : { "type":"chat", "message":"..." }

2) "recipe" : {
 "type":"recipe",
 "message":"phrase courte d'introduction ou explication de ce qui a changé",
 "recipe":{
  "nom":"...",
  "personnes":4,
  "temps_preparation_min":15,
  "temps_cuisson_min":30,
  "difficulte":"facile|moyen|difficile",
  "cout_total_fcfa":2500 ou null,
  "ingredients":[{"nom":"riz","quantite":400,"unite":"g","condiment":false,"disponible":null,"cout_fcfa":300}],
  "materiel":["casserole","planche à découper"],
  "etapes":[{"texte":"Coupe les oignons en petits morceaux.","minuteur_secondes":null,"minuteur_label":null}],
  "conseils":["..."]
 }
}
 - "quantite" est un nombre (ou null si "au goût"). "unite" est une chaîne : "g", "kg", "ml", "cl", "L", "c. à soupe", "c. à café", "pincée", "" pour des éléments comptés (ex: 2 oignons), etc.
 - "condiment" vaut true pour sel, poivre, épices, bouillon, piment, ail, gingembre, herbes, etc.
 - "disponible" vaut true si l'utilisateur a dit posséder l'ingrédient, false si non, null s'il n'a rien précisé.
 - Chaque étape = une seule action claire, phrase courte à l'impératif, 5 à 12 étapes.
 - Si une étape implique un temps précis de cuisson ou d'attente, renseigne "minuteur_secondes" (entier, en secondes) et "minuteur_label" (ex: "Cuisson du riz"). Pour une fourchette, prends la valeur habituelle.
 - Si deux cuissons se font en parallèle, mets-les dans deux étapes consécutives distinctes, chacune avec son minuteur.
 - Pour toute modification demandée (moins cher, plus épicé, sans piment, autre ingrédient, autre nombre de personnes, plus rapide...), renvoie la recette COMPLÈTE mise à jour (type "recipe"), jamais seulement la différence.

3) "suggestions" : {
 "type":"suggestions",
 "message":"phrase courte",
 "suggestions":[{"nom":"...","resume":"une phrase","personnes":4,"difficulte":"facile","temps_minutes":20,"disponibles":["..."],"manquants":["..."],"remplacables":[{"manquant":"beurre","remplacement":"huile"}],"cout_total_fcfa":1800 ou null}]
}
 - Donne 3 à 5 propositions réalistes. Renseigne "disponibles", "manquants" et "remplacables" quand l'utilisateur a listé ses ingrédients, sinon laisse des listes vides.

4) "plan" : {
 "type":"plan",
 "message":"phrase courte",
 "plan":{"personnes":2,"jours":[{"jour":"Lundi","petit_dejeuner":null,"dejeuner":"Riz au poulet","diner":"Omelette"}]}
}
 - N'inclus que les jours et repas demandés (mets null pour un repas non demandé). Varie les plats et respecte le budget et les préférences.

5) "courses" : {
 "type":"courses",
 "message":"phrase courte",
 "courses":[{"nom":"riz","quantite":2,"unite":"kg"}]
}
 - Liste globale regroupée (additionne les quantités d'un même ingrédient) pour tout un programme de repas.

CONTRAINTES SPÉCIALES
- Petit budget : respecte le budget autant que possible, renseigne "cout_fcfa" par ingrédient et "cout_total_fcfa". Si c'est irréaliste, dis-le honnêtement dans "message" et propose l'option la plus proche.
- Mode rapide : le temps total (préparation + cuisson) ne doit pas dépasser le temps indiqué.
- Si on te donne une "[Recette actuelle]", c'est celle sur laquelle porte la conversation.`;

const app = express();
app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Limite simple : 20 requêtes IA par minute et par adresse IP
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now > h.reset) { hits.set(ip, { count: 1, reset: now + 60000 }); return false; }
  h.count += 1;
  return h.count > 20;
}

app.get('/api/config', (req, res) => {
  res.json({ formUrl: /^https?:\/\//i.test(FORM_URL) ? FORM_URL : '' });
});

function buildContents(history, message, recipe) {
  const turns = [];
  const push = (role, text) => {
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.parts[0].text += '\n\n' + text;
    else turns.push({ role, parts: [{ text }] });
  };
  (Array.isArray(history) ? history : []).slice(-12).forEach(h => {
    if (!h || typeof h.text !== 'string' || !h.text.trim()) return;
    const role = h.role === 'assistant' ? 'model' : 'user';
    if (!turns.length && role === 'model') return;
    push(role, h.text.slice(0, 1500));
  });
  let finalText = String(message).slice(0, 3000);
  if (recipe && typeof recipe === 'object') {
    const json = JSON.stringify(recipe);
    if (json.length <= 12000) finalText += '\n\n[Recette actuelle]\n' + json;
  }
  push('user', finalText);
  return turns;
}

function parseJson(text) {
  let t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(t); } catch (e) { /* on tente d'extraire l'objet */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a !== -1 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { /* ignore */ } }
  return null;
}

async function callGemini(model, contents) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        generationConfig: { responseMimeType: 'application/json' }
      }),
      signal: ctrl.signal
    });
    const data = await r.json().catch(() => ({}));
    return { status: r.status, data };
  } finally {
    clearTimeout(timer);
  }
}

app.post('/api/ai', async (req, res) => {
  if (!API_KEY || API_KEY.startsWith('COLLE_')) {
    return res.status(503).json({ error: "La clé API Gemini n'est pas configurée. Ouvre le fichier .env et renseigne GEMINI_API_KEY." });
  }
  if (rateLimited(req.ip)) {
    return res.status(429).json({ error: 'Trop de demandes en peu de temps. Attends une minute puis réessaie.' });
  }
  const { message, history, recipe } = req.body || {};
  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Message vide.' });
  }
  const contents = buildContents(history, message, recipe);

  try {
    let result = null;
    let overloaded = false;
    const wait = ms => new Promise(r => setTimeout(r, ms));
    for (const model of MODELS) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const { status, data } = await callGemini(model, contents);
        if (status === 404) break; // modèle introuvable : on essaie le suivant
        if (status !== 200) {
          const msg = (data && data.error && data.error.message) || '';
          if (status === 400 && /api key/i.test(msg)) return res.status(502).json({ error: 'La clé API Gemini est invalide. Vérifie le fichier .env.' });
          if (status === 403) return res.status(502).json({ error: "Accès refusé par Gemini. Vérifie ta clé API et ses autorisations." });
          if (status === 429 || status >= 500) {
            // Service surchargé ou limite atteinte : petite pause puis nouvel essai, sinon modèle suivant
            overloaded = true;
            if (attempt < 2) { await wait(1200 * (attempt + 1)); continue; }
            break;
          }
          return res.status(502).json({ error: 'Erreur du service IA (' + status + '). Réessaie.' });
        }
        overloaded = false;
        const text = (((data.candidates || [])[0] || {}).content || {}).parts;
        const joined = Array.isArray(text) ? text.map(p => p.text || '').join('') : '';
        const parsed = parseJson(joined);
        if (parsed && typeof parsed === 'object' && parsed.type) { result = parsed; break; }
        if (!joined && data.promptFeedback && data.promptFeedback.blockReason) {
          return res.status(422).json({ error: "Cette demande n'a pas pu être traitée. Reformule-la." });
        }
      }
      if (result) break;
    }
    if (!result && overloaded) {
      return res.status(503).json({ error: "Le service IA est très sollicité en ce moment. Réessaie dans quelques secondes." });
    }
    if (!result) {
      return res.json({ type: 'chat', message: "Je n'ai pas réussi à préparer une réponse lisible. Peux-tu reformuler ta demande ?" });
    }
    res.json(result);
  } catch (err) {
    const timeout = err && err.name === 'AbortError';
    res.status(504).json({ error: timeout ? "L'IA met trop de temps à répondre. Réessaie." : "Impossible de joindre le service IA. Vérifie ta connexion." });
  }
});

app.listen(PORT, () => {
  console.log(`Assistant Cuisine prêt : http://localhost:${PORT}`);
  if (!API_KEY || API_KEY.startsWith('COLLE_')) console.log('⚠  Pense à renseigner GEMINI_API_KEY dans le fichier .env');
});
