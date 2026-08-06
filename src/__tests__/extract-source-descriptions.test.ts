import { describe, it, expect } from 'vitest';
import { extractSourceDescriptions } from '../code-knowledge-recall.js';

describe('extractSourceDescriptions', () => {
  const PAGE_CONTENT = [
    '### RestartController',
    'Handles restart logic for inference services',
    '- `file:hai_flow/service/k8s/api/restart_infer_workload_controller.py:15` | refs: 3',
    '',
    '### DescribeController',
    'Describes workload pod status and health',
    '- `file:hai_flow/service/k8s/api/describe_infer_workload_controller.py:8` | refs: 2',
    '',
    '### UtilsHelper',
    'Common utility functions for K8s operations',
    '- `file:hai_flow/service/k8s/utils.py:1` | refs: 10',
    '- `file:hai_flow/service/common/utils.py:1` | refs: 5',
  ].join('\n');

  it('full path match extracts correct description', () => {
    const result = extractSourceDescriptions(
      ['hai_flow/service/k8s/api/restart_infer_workload_controller.py'],
      PAGE_CONTENT,
    );
    expect(result).toEqual([{
      path: 'hai_flow/service/k8s/api/restart_infer_workload_controller.py',
      desc: 'Handles restart logic for inference serv',
    }]);
  });

  it('basename collision resolved by full path priority', () => {
    // Both share basename "utils.py" but full path distinguishes them
    const result = extractSourceDescriptions(
      ['hai_flow/service/k8s/utils.py', 'hai_flow/service/common/utils.py'],
      PAGE_CONTENT,
    );
    // Both should map to UtilsHelper since content has both paths under same h3
    expect(result[0].desc).toBe('Common utility functions for K8s operati');
    expect(result[1].desc).toBe('Common utility functions for K8s operati');
  });

  it('no match returns path only', () => {
    const result = extractSourceDescriptions(
      ['nonexistent/file.py'],
      PAGE_CONTENT,
    );
    expect(result).toEqual([{ path: 'nonexistent/file.py' }]);
  });

  it('h3 found but no description line returns path only', () => {
    const content = [
      '### EmptySection',
      '- `file:src/empty.py:1` | refs: 1',
    ].join('\n');
    const result = extractSourceDescriptions(['src/empty.py'], content);
    expect(result).toEqual([{ path: 'src/empty.py' }]);
  });

  it('description truncated to 40 chars', () => {
    const content = [
      '### LongDesc',
      'This is a very long description that exceeds the forty character limit significantly',
      '- `file:src/long.py:1` | refs: 1',
    ].join('\n');
    const result = extractSourceDescriptions(['src/long.py'], content);
    expect(result[0].desc).toBe('This is a very long description that exc');
    expect(result[0].desc!.length).toBe(40);
  });

  it('multiple sources each get correct description', () => {
    const result = extractSourceDescriptions(
      [
        'hai_flow/service/k8s/api/restart_infer_workload_controller.py',
        'hai_flow/service/k8s/api/describe_infer_workload_controller.py',
      ],
      PAGE_CONTENT,
    );
    expect(result[0].desc).toBe('Handles restart logic for inference serv');
    expect(result[1].desc).toBe('Describes workload pod status and health');
  });

  it('empty sources array returns empty array', () => {
    const result = extractSourceDescriptions([], PAGE_CONTENT);
    expect(result).toEqual([]);
  });
});
