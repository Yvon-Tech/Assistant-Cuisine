# Assistant Cuisine IA - V1

## Ce que tu dois ajouter
1. Ouvre le fichier `.env` (fichier caché, active l'affichage des fichiers cachés si besoin) :
   - `GEMINI_API_KEY` : ta clé API Gemini
   - `FEEDBACK_FORM_URL` : le lien de ton Google Forms
2. Place ton fichier audio dans `public/assets/` sous le nom exact `sonnerie.mp3`
   (sans lui, l'appli joue un simple bip).

## Lancer
```
npm install
npm start
```
Puis ouvre http://localhost:3000 (Node.js 18 ou plus requis).

## Notes
- La clé API reste côté serveur (`.env`), jamais dans le navigateur.
- Modèle utilisé : `gemini-3.6-flash` (modifiable avec `GEMINI_MODEL` dans `.env`).
- Ne partage jamais le fichier `.env`.
