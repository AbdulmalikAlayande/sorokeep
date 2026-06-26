const fs = require('fs');
const prs = JSON.parse(fs.readFileSync('prs.json', 'utf8'));
for (const pr of prs) {
    console.log(`PR #${pr.number}: ${pr.title}`);
}
