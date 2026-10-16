# Result selection example

Install this directory as a Skill or copy its files into a Skill created in qz. Load
`result-selection-example` and call `result_selection_example__choose` with `{"timeout":10}`.
Select one or more cards, then choose **Research selected roles**. The tool returns the selected
records to the Agent. The sample vacancies are synthetic and require no network access.

Replace the script's `items` with your collected results and keep each `id` stable. See the
[authoring guide](../../../../docs/skill-result-selection.md) for the renderer contract.
