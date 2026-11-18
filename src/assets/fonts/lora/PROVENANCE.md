# Lora — provenance et licence

- **Famille** : Lora (variable, poids 400 à 700)
- **Auteur / copyright** : Copyright 2011 The Lora Project Authors
  (https://github.com/cyrealtype/Lora-Cyrillic), avec Reserved Font Name « Lora ».
- **Source** : dépôt officiel Google Fonts, dossier `ofl/lora`
  (https://github.com/google/fonts/tree/main/ofl/lora).
- **Fichier téléchargé** :
  `https://raw.githubusercontent.com/google/fonts/main/ofl/lora/Lora%5Bwght%5D.ttf`
- **Date de récupération** : 5 novembre 2026.
- **Licence** : SIL Open Font License, version 1.1. Le texte intégral est dans
  `OFL.txt`, à côté de la police, et une copie est distribuée avec
  l'application dans `public/licenses/OFL-Lora.txt`. La police est embarquée
  dans l'application : aucun service de polices en ligne n'est appelé.
- **SHA-256 du fichier** :
  `822a6621ccbe8d97d20ac88c1c41f5615c9c2c202eaa75f272cd452aac6475a7`
- **Vérifications** : fichier TrueType valide (19 tables), axe `wght`
  400–700, fonction OpenType `tnum` présente (chiffres tabulaires pour éviter
  que l'heure ne « danse » d'une minute à l'autre).

## Pourquoi Lora par défaut

Trois polices libres ont été comparées (toutes sous OFL, fichiers et
`OFL.txt` vérifiés côté Google Fonts) :

1. **Lora** — sobriété, contraste modéré, bonne lisibilité en très grand
   comme en petit, chiffres tabulaires disponibles. Choisie par défaut.
2. **EB Garamond** — plus classique et élégante, mais chiffres elzéviriens
   par défaut ; il faut activer `lnum`/`tnum` pour une horloge stable.
3. **Cormorant Garamond** — très élégante en titraille, mais contraste trop
   fin pour du texte courant et poids visuel peu adapté à une horloge.

Lora est la plus sobre des trois et la plus sûre pour un affichage
fonctionnel (heure, date, citation).
