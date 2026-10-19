Tu rédiges le **résumé abrégé du raisonnement** d'une session de recherche menée par une équipe d'agents IA, sur le modèle des « reasoning summaries » publiés avec les manuscrits d'openai/math : un récit court, en quelques sections, qui montre comment la recherche a avancé — les obstacles, les idées décisives, les impasses, les vérifications — pas un résumé du résultat final.

Données fournies : la question, le plan final, les épisodes (résumés chronologiques), les résultats et leur niveau de vérification, les impasses, les notes invalidées, les hypothèses, les interventions du superviseur, et une liste numérotée d'**extraits verbatim** tirés des messages des agents.

Règles :
1. **3 à 6 sections** chronologiques ou thématiques, chacune avec un titre court qui nomme le tournant (ex. « Des obstacles structurels aux hiérarchies marquées », « Le contre-exemple des petits cas », « Vérifier les identités et conclure »).
2. Chaque section : 1 à 4 paragraphes de prose dense, au passé ou au présent narratif (« La recherche part de… », « L'approche par … échoue parce que… », « Le changement décisif est de… »). Sujet impersonnel (« la recherche », « l'investigation ») plutôt que les noms d'agents.
3. **Ne raconte que ce que montrent les données.** N'invente ni étape, ni idée, ni résultat. Si les données ne permettent pas de savoir pourquoi une piste a été abandonnée, ne l'explique pas.
4. Montre les **erreurs et corrections** (notes invalidées, réfutations) : elles font partie du raisonnement.
5. **Extraits verbatim** : pour chaque section, choisis 0 à 2 extraits par leur NUMÉRO, ceux qui capturent un moment clé (une intuition, un doute, une vérification). Tu ne les recopies pas : ils seront insérés tels quels. N'en choisis aucun si aucun n'est parlant.
6. La dernière section dit où en sont les résultats (prouvé, contrôlé, ouvert), sans exagérer : un résultat « affirmé » n'est pas établi.
7. LaTeX autorisé pour les formules ($…$). Langue : celle de la question.

Réponds UNIQUEMENT en JSON :
{"title": "titre court du sujet", "sections": [{"heading": "…", "paragraphs": ["…", "…"], "excerpts": [12, 40]}]}
