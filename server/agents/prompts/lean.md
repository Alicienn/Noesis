<formalisation_lean>
Formalisation : **{{policy}}**. Outils : `lean_run` (compiler un fichier contre Mathlib, boucle de travail), `lean_search` (chercher un lemme dans Mathlib), `lean_check` (verdict définitif de Comparator).

Protocole (celui d'openai/math) :
1. **Énoncé d'abord.** Écris `lean/<sujet>/Challenge.lean` : `import Mathlib`, les définitions strictement nécessaires, puis `theorem nom … := by sorry`. Il doit être court, lisible par un humain et dire EXACTEMENT ce qu'affirme la note : mêmes quantificateurs, mêmes hypothèses, même portée. Vérifie qu'il compile (`lean_run`, seul `sorry` attendu).
2. **Preuve ensuite.** `lean/<sujet>/Solution.lean` est autonome : il redéclare les mêmes définitions et le même théorème (même nom, même namespace), cette fois prouvé. Il n'importe pas le challenge. Pas de `sorry`, pas d'`axiom`, pas de `native_decide` (axiome supplémentaire).
3. **Mise au point** avec `lean_run` : découpe en lemmes, `sorry` sur les étapes ouvertes, `exact?` / `apply?` / `simp?` / `aesop` / `omega` / `linarith` / `nlinarith` / `positivity` / `norm_num` / `decide`, `#check` pour un nom. Lis les buts restants dans la sortie. Un nom de lemme inconnu → `lean_search` plutôt que deviner.
4. **Verdict** : `lean_check(challenge, solution, theorems=[…], note_slug=…)`. Accepté = la note passe au niveau « Prouvé en Lean ».
5. **Fidélité** : demande `verify_claim(kind="formalization", note_slug=…, context="lean/checks/<id>/Challenge.lean")`. Une preuve d'un énoncé infidèle ne prouve rien.

Pièges classiques d'un énoncé infidèle : valeurs par défaut de Mathlib (`SimpleGraph.dist` vaut 0 entre sommets non reliés, donc un énoncé « dist ≤ … » ne prouve pas la connexité : ajoute `Reachable` ; `sSup ∅`, `Nat.find`, `.toNat`…), soustraction et division dans ℕ (tronquées, `x / 0 = 0`), hypothèse oubliée ou en trop, `∃` au lieu de `∀`, ensemble vide ou cas dégénéré qui rend l'énoncé trivial, coercions ℕ→ℝ mal placées, définition « trou » (laissée en sorry dans le challenge) que la solution remplit de façon triviale.

Ne formalise que ce qui en vaut la peine : le résultat central et ses lemmes clés, pas chaque calcul. Si Mathlib n'a pas les définitions nécessaires et qu'il faudrait des milliers de lignes, dis-le (note `dead_end` ou limite du rapport) au lieu de t'y enliser. {{policy_detail}}
</formalisation_lean>
