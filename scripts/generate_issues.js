import { execSync } from "child_process";
import readline from "readline";
import fs from "fs";
import path from "path";

// ─── Command Executions ──────────────────────────────────────────────────────

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function ask(question) {
    return new Promise((resolve) => rl.question(question, resolve));
}

// Complexity label configurations
const COMPLEXITY_LABELS = {
    trivial: { name: "complexity:trivial", color: "0e8a16", desc: "Trivial complexity - 100 pts" },
    medium: { name: "complexity:medium", color: "fbca04", desc: "Medium complexity - 150 pts" },
    high: { name: "complexity:high", color: "d93f0b", desc: "High complexity - 200+ pts" }
};

// Phase configurations
const PHASES = {
    "phase-1": { name: "Phase 1: Complete the Core", color: "fbca04" },
    "phase-2": { name: "Phase 2: Developer Experience & Safety", color: "0075ca" },
    "phase-3": { name: "Phase 3: State Introspection & Observability", color: "d93f0b" },
    "phase-4": { name: "Phase 4: Ecosystem Integration", color: "bfd4f2" },
    "phase-5": { name: "Phase 5: Production Hardening & Scale", color: "a2eeef" }
};

async function run() {
    console.log("\n🚀 Welcome to the Sorokeep GitHub Issues Generator");
    console.log("This script imports structured, granular issues into your GitHub repository using the GitHub CLI (gh).\n");

    // Check if issues_db.json exists
    const dbPath = path.resolve("./scripts/issues_db.json");
    if (!fs.existsSync(dbPath)) {
        console.error("❌ Error: scripts/issues_db.json not found. Run 'node scripts/make_issues_db.js' first.");
        process.exit(1);
    }

    let issues = [];
    try {
        issues = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
        console.log(`✔ Loaded ${issues.length} issues from database.`);
    } catch (err) {
        console.error("❌ Error: Failed to parse scripts/issues_db.json.");
        console.error(err.message);
        process.exit(1);
    }

    // Check if gh CLI is installed
    try {
        execSync("gh --version", { stdio: "ignore" });
    } catch {
        console.error("❌ Error: GitHub CLI ('gh') is not installed or not in your PATH.");
        console.log("Please install it from https://cli.github.com/ and log in using 'gh auth login'.");
        process.exit(1);
    }

    // Check if authenticated
    try {
        execSync("gh auth status", { stdio: "ignore" });
        console.log("✔ GitHub CLI is authenticated.");
    } catch {
        console.error("❌ Error: GitHub CLI is not authenticated.");
        console.log("Please run 'gh auth login' to authenticate with your GitHub account first.");
        process.exit(1);
    }

    // Get current repository
    let repo;
    try {
        repo = execSync("gh repo view --json nameWithOwner -q .nameWithOwner", { encoding: "utf-8" }).trim();
        console.log(`✔ Target Repository: ${repo}`);
    } catch {
        console.error("❌ Error: Not in a git repository or the repository has no remote set up.");
        process.exit(1);
    }

    // List phases and ask which ones to import
    console.log("\nAvailable Phases to import:");
    const phaseCounts = {};
    issues.forEach(issue => {
        phaseCounts[issue.phase] = (phaseCounts[issue.phase] || 0) + 1;
    });

    Object.entries(PHASES).forEach(([phaseKey, config]) => {
        const count = phaseCounts[phaseKey] || 0;
        console.log(`  [${phaseKey}] ${config.name} (${count} issues)`);
    });

    const answer = await ask("\nWhich phases would you like to import? (comma-separated, e.g., 'phase-1,phase-2' or 'all'): ");
    let selectedPhases = [];

    if (answer.trim().toLowerCase() === "all") {
        selectedPhases = Object.keys(PHASES);
    } else {
        selectedPhases = answer.split(",").map(x => x.trim()).filter(x => PHASES[x]);
    }

    if (selectedPhases.length === 0) {
        console.log("No valid phases selected. Exiting.");
        process.exit(0);
    }

    // Confirm labels creation
    const createLabelsAns = await ask("Would you like to auto-create GitHub labels (stellar-wave, phases, complexity)? (y/n): ");
    if (createLabelsAns.trim().toLowerCase() === "y") {
        try {
            console.log("Creating label 'stellar-wave'...");
            execSync(`gh label create "stellar-wave" --color "4c1d95" --description "Stellar Wave Program" --force`, { stdio: "ignore" });
        } catch (err) {}

        for (const phaseKey of selectedPhases) {
            const phase = PHASES[phaseKey];
            try {
                console.log(`Creating label '${phaseKey}'...`);
                execSync(`gh label create "${phaseKey}" --color "${phase.color}" --description "${phase.name}" --force`, { stdio: "ignore" });
            } catch (err) {}
        }

        for (const config of Object.values(COMPLEXITY_LABELS)) {
            try {
                console.log(`Creating label '${config.name}'...`);
                execSync(`gh label create "${config.name}" --color "${config.color}" --description "${config.desc}" --force`, { stdio: "ignore" });
            } catch (err) {}
        }
        console.log("✔ Labels created.");
    }
        
    // Filter issues to import
    let issuesToImport = issues.filter(issue => selectedPhases.includes(issue.phase));
    // Skip the first 4 issues since they were already successfully uploaded
    issuesToImport = issuesToImport.slice(4);
    
    console.log(`\nPrepared ${issuesToImport.length} issues for import.`);

    const confirmIssues = await ask(`Proceed with importing these issues to GitHub? (y/n): `);
    if (confirmIssues.trim().toLowerCase() !== "y") {
        console.log("Aborted.");
        process.exit(0);
    }

    let totalCreated = 0;
    for (const issue of issuesToImport) {
        const title = issue.title;
        const body = issue.body;
        const complexityLabel = COMPLEXITY_LABELS[issue.complexity]?.name || `complexity:${issue.complexity}`;
        
        try {
            process.stdout.write(`    Creating issue: "${title.slice(0, 50)}..." `);
            fs.writeFileSync(".temp_issue.md", body, "utf-8");
            execSync(`gh issue create --title "${title}" --body-file ".temp_issue.md" --label "${issue.phase}" --label "stellar-wave" --label "${complexityLabel}"`);
            console.log("✔");
            totalCreated++;
        } catch (err) {
            console.log("❌ Failed");
            if (err.stderr) {
                console.error("GH CLI Error:", err.stderr.toString());
            } else {
                console.error(err.message);
            }
            break; // Stop on first error so we can debug it
        }
    }
    if (fs.existsSync(".temp_issue.md")) {
        fs.unlinkSync(".temp_issue.md");
    }

    console.log(`\n🎉 Success! Created a total of ${totalCreated} issues on ${repo}.`);
    rl.close();
}

run().catch(err => {
    console.error(err);
    rl.close();
});
