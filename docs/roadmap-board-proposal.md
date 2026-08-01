# GitHub Projects Board — Roadmap Proposal

## Summary

Create a GitHub Projects (v2) board for `AbdulmalikAlayande/sorokeep` that surfaces
all `phase-*`-labeled issues in a single grouped view, giving contributors and
maintainers an at-a-glance picture of progress across 15 phases.

---

## Prerequisites

- **GitHub account** with `admin` or `write` access to the repository.
- A personal access token (classic) with the `project` scope, **or** a GitHub
  App token with `Projects` permissions.

---

## Step 1 — Create the Project Board

1. Go to your GitHub **Profile** or **Organization** page → click the **Projects** tab.
2. Click **New project**.
3. Select the **Board** template (or start from scratch).
4. **Project name:** `Sorokeep Roadmap`
5. **Project description:**
   > Progress tracking across all 15 implementation phases. Issues are
   > auto-added when labeled with `phase-*`.
6. Click **Create**.
7. Return to https://github.com/AbdulmalikAlayande/sorokeep, click the **Projects** tab, then **Link a project**, search for `Sorokeep Roadmap`, and link it.

---

## Step 2 — Configure the Board Layout

### 2a — Add the repository

1. In the new project, click the **⋮** menu (top right) → **Settings**.
2. Under **Linked repositories**, click **Link a repository**.
3. Search for and select `AbdulmalikAlayande/sorokeep`.

### 2b — Create a Phase custom field and configure the default view

1. Click back to the project board view.
2. Click the **+** button in the table header area → **New field** → **Single select**.
3. **Field name:** `Phase` — add an option for each phase label (`phase-1` through `phase-15`), matching the label names.
4. Rename the default view tab to **"By Phase"**.
5. Click the **Group by** dropdown (top right of the board) and select **Phase**.
6. In the **Sort** dropdown, select **Label name** → **A → Z** (so phases appear in natural order).
7. Add a **filter** to only show issues with `phase-*` labels: click the filter bar and enter `has:label,phase-`.
8. The board will now show columns for each phase option.

### 2c — Add status tracking

Each card will show the issue status automatically. Ensure the **Status** field
is visible:

1. Click the **Fields** button (top right, near the views tab).
2. Make sure **Status** is enabled. The status values are:
   - `Todo` — issue is open, not yet assigned / in progress
   - `In Progress` — assignee is actively working
   - `Done` — issue is completed and closed
3. Optionally, add a **Labels** field as well.

---

## Step 3 — Automation (Auto-Add)

GitHub Projects v2 has built-in automation via **Workflows** (not to be confused
with GitHub Actions).

1. In the project board, click the **⋮** menu (top right) → **Workflows**.
2. Click **Add workflow** → select **"Auto-add to project"**.
3. Configure the trigger:
   - **Repository:** `AbdulmalikAlayande/sorokeep`
   - **Filters:** Issues with any `phase-*` label (e.g. enter `label:phase-1` or use the label filter criteria to match all 15 phase labels)
   - **Action:** Add the issue to this project.
4. Click **Save** and enable the workflow.

> This workflow ensures any new or newly-labeled issue with a `phase-*`
> label will automatically appear on the board. Pre-existing matching items
> require a separate backfill (Step 4).

---

## Step 4 — Backfill Existing Issues

To pull in all existing `phase-*` issues at once:

**Option A — Manual (quick for a one-time sync)**
1. From the project board, click **Add item** → type `#` followed by an issue
   number → select the issue. Repeat for each phase-labeled issue.

**Option B — GraphQL API (bulk)**

```graphql
mutation {
  addProjectV2ItemById(input: {
    projectId: "<PROJECT_ID>"
    contentId: "<ISSUE_NODE_ID>"
  }) { item { id } }
}
```

Fetch all phase-labeled issue IDs (paginated to get all results):

```shell
gh issue list --repo AbdulmalikAlayande/sorokeep \
  --label phase-1,phase-2,phase-3,phase-4,phase-5,phase-6,phase-7,phase-8,phase-9,phase-10,phase-11,phase-12,phase-13,phase-14,phase-15 \
  --state all \
  --json id --jq '.[].id' \
  --limit 500
```

Loop over each returned ID and call the GraphQL mutation above (e.g. with `gh api graphql` or a script) to add every issue to the project.

> **Tip:** The workflow in Step 3 will *not* retroactively add existing issues;
> only newly-labelled ones. Use Option A or B for the initial backfill.

---

## Step 5 — Verify

1. Confirm the board displays issues grouped by `phase-1` through `phase-15`.
2. For each phase column, verify that open and closed counts match the
   repository's issue list for that label.
3. Create a test issue with a `phase-1` label (can be immediately closed):
   - The issue should appear on the board within ~30 seconds.
   - Remove or close the test issue afterward.

---

## Maintenance Notes

- **New phases:** If `phase-16` is ever added, update the workflow trigger in
  Step 3 to include the new label.
- **View duplication:** Interested contributors can create additional views
  (e.g. "By Assignee" or "My Tasks") without affecting the main layout.
- **Access control:** Any user with `read` access to the repo can view the board.
  Modifying cards requires **Project Write** permission (separate from repository
  permissions). For a private project, collaborators must also be granted Project
  access via the project's **Manage access** settings.