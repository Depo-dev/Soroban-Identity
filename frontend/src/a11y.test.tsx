import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import axe from 'axe-core';
import FormField from './components/FormField';
import ReputationChart from './components/ReputationChart';

/**
 * Run axe against a container and return only the violations, so a failure
 * message names the rules that broke rather than dumping the full report.
 */
async function findViolations(container: HTMLElement) {
  const results = await axe.run(container, {
    // Colour contrast needs real layout and computed styles, which jsdom does
    // not provide; it is verified against the running app instead.
    rules: { 'color-contrast': { enabled: false } },
  });
  return results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    nodes: violation.nodes.map((node) => node.html),
  }));
}

describe('FormField accessibility', () => {
  it('associates its label with the input', () => {
    render(<FormField label="Subject Address" value="" onChange={() => {}} name="subject" />);

    const input = screen.getByLabelText('Subject Address');
    expect(input.tagName).toBe('INPUT');
    expect(input.id).toBe('subject');
  });

  it('links its error message to the input and announces it', () => {
    render(
      <FormField
        label="Subject Address"
        value="bad"
        onChange={() => {}}
        name="subject"
        error="Invalid Stellar address"
      />,
    );

    const input = screen.getByLabelText('Subject Address');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe('subject-error');
    expect(screen.getByRole('alert').textContent).toBe('Invalid Stellar address');
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <FormField
        label="Subject Address"
        value=""
        onChange={() => {}}
        name="subject"
        error="Required"
      />,
    );
    expect(await findViolations(container)).toEqual([]);
  });
});

const HISTORY = [
  { reporter: 'GREPORTER1', delta: 10, reason: 'attested', submittedAt: 1700000000 },
  { reporter: 'GREPORTER2', delta: -5, reason: 'disputed', submittedAt: 1700086400 },
];

describe('ReputationChart accessibility', () => {
  it('associates the date filter labels with their inputs', () => {
    render(<ReputationChart history={HISTORY} />);

    expect(screen.getByLabelText('Start Date').id).toBe('reputation-start-date');
    expect(screen.getByLabelText('End Date').id).toBe('reputation-end-date');
  });

  it('has no axe violations', async () => {
    const { container } = render(<ReputationChart history={HISTORY} />);
    expect(await findViolations(container)).toEqual([]);
  });
});
