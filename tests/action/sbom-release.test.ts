import { test, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';

test('release workflow has SBOM generation and upload steps', () => {
    const workflowPath = path.resolve(__dirname, '../../.github/workflows/release.yml');
    const content = fs.readFileSync(workflowPath, 'utf8');
    const parsed = yaml.parse(content);

    const publishNpmSteps = parsed.jobs['publish-npm'].steps;
    
    // Check for SBOM generation
    const sbomStep = publishNpmSteps.find((s: any) => s.run && s.run.includes('@cyclonedx/cyclonedx-npm'));
    expect(sbomStep).toBeDefined();
    
    // Check for gh release upload
    const uploadStep = publishNpmSteps.find((s: any) => s.run && s.run.includes('gh release upload'));
    expect(uploadStep).toBeDefined();
});
