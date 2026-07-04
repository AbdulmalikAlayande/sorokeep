const { execSync } = require('child_process');

function run(cmd, options = {}) {
    console.log('\n> ' + cmd);
    return execSync(cmd, { stdio: 'inherit', encoding: 'utf-8', ...options });
}

function runSilent(cmd) {
    return execSync(cmd, { encoding: 'utf-8', stdio: 'pipe' }).trim();
}

try {
    // 1. Ensure we are on a clean working directory
    const status = runSilent('git status --porcelain');
    if (status) {
        console.error('Working directory is not clean. Please commit or stash changes.');
        process.exit(1);
    }

    // 2. Get all pr-* branches
    const branchesOutput = runSilent('git branch --list "pr-*"');
    const branches = branchesOutput.split('\n')
        .map(b => b.replace('*', '').trim())
        .filter(b => b.startsWith('pr-'));

    // 3. Get merged branches
    const mergedOutput = runSilent('git branch --merged main --list "pr-*"');
    const mergedBranches = new Set(
        mergedOutput.split('\n')
            .map(b => b.replace('*', '').trim())
            .filter(b => b.startsWith('pr-'))
    );

    // 4. Find unmerged branches and sort by PR number
    const unmerged = branches
        .filter(b => !mergedBranches.has(b))
        .sort((a, b) => {
            const matchA = a.match(/\d+/);
            const matchB = b.match(/\d+/);
            const numA = matchA ? parseInt(matchA[0], 10) : 0;
            const numB = matchB ? parseInt(matchB[0], 10) : 0;
            return numA - numB;
        });

    if (unmerged.length === 0) {
        console.log('No unmerged PR branches found!');
        process.exit(0);
    }

    const nextPr = unmerged[0];
    console.log(`\n============================================`);
    console.log(`Processing next PR: ${nextPr} (${unmerged.length} remaining)`);
    console.log(`============================================\n`);

    // Check if we are already on this branch
    const currentBranch = runSilent('git branch --show-current');
    if (currentBranch !== nextPr) {
        run(`git checkout ${nextPr}`);
    }

    // Attempt to merge main
    console.log(`Merging main into ${nextPr}...`);
    try {
        run('git merge main');
    } catch (e) {
        console.error('\nMerge conflict detected! Please resolve conflicts, commit, and then run this script again.');
        process.exit(1);
    }

    // Run tests
    console.log('Running tests...');
    try {
        run('npx vitest run');
    } catch (e) {
        console.error('\nTests failed! Please fix the code on this branch, commit the fixes, and run this script again.');
        process.exit(1);
    }

    // Merge to main
    console.log(`Tests passed! Merging ${nextPr} to main...`);
    run('git checkout main');
    run(`git merge ${nextPr}`);
    
    // Delete the local branch
    run(`git branch -d ${nextPr}`);

    console.log(`\nSuccessfully processed and merged ${nextPr}! Run the script again for the next PR.`);
} catch (e) {
    console.error('An error occurred:', e.message);
    process.exit(1);
}
