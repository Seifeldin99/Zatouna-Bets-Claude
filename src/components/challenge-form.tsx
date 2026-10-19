import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button, Chip, ErrorText, Hint, InfoBox, InfoRow, SectionLabel, Stepper, TextField } from '@/components/ui';
import {
  type Challenge,
  type ChallengeFields,
  MAX_LENGTH_DAYS,
  MAX_START_DAYS_AHEAD,
  MIN_LENGTH_DAYS,
  RULE_MAX,
  TITLE_MAX,
  howOften,
} from '@/lib/challenges';
import { addDays, dayCount, daysFromToday, formatDate, lastDay, relativeDay, todayYmd } from '@/lib/dates';
import { templates } from '@/lib/templates';
import { colors, fonts } from '@/theme';

type Props = {
  /** Set when editing; the stake is then locked, and the start too once it has begun. */
  initial?: Challenge;
  /** The creator's tokens, shown under the stake. */
  balance?: number | null;
  submitLabel: string;
  onSubmit: (fields: ChallengeFields) => Promise<void>;
};

export function ChallengeForm({ initial, balance, submitLabel, onSubmit }: Props) {
  const editing = initial !== undefined;
  const startLocked = editing && initial.status === 'active';
  const [template, setTemplate] = useState<number | null>(null);
  const [title, setTitle] = useState(initial?.title ?? '');
  const [rule, setRule] = useState(initial?.rule ?? '');
  const [timesPerWeek, setTimesPerWeek] = useState(initial?.times_per_week ?? 7);
  const [startIn, setStartIn] = useState(initial ? Math.max(0, daysFromToday(initial.start_date)) : 0);
  const [lengthDays, setLengthDays] = useState(initial?.length_days ?? 7);
  const [missesAllowed, setMissesAllowed] = useState(initial?.misses_allowed ?? 0);
  const [stakeText, setStakeText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startDate = startLocked ? initial.start_date : addDays(todayYmd(), startIn);
  const endDate = lastDay(startDate, lengthDays);
  const stake = editing ? initial.stake : Number.parseInt(stakeText, 10);

  function pickTemplate(index: number | null) {
    setTemplate(index);
    if (index !== null) {
      setTitle(templates[index].name);
      setRule(templates[index].rule);
    }
  }

  function changeLength(next: number) {
    setLengthDays(next);
    setMissesAllowed((m) => Math.min(m, next - 1));
  }

  function validate(): string | null {
    if (!title.trim()) return 'Give the challenge a title.';
    if (!editing) {
      if (!Number.isInteger(stake) || stake < 1) return 'The stake must be at least 1 token.';
      if (balance != null && stake > balance) {
        return `You have ${balance} tokens, so the stake can be ${balance} at most.`;
      }
    }
    return null;
  }

  async function submit() {
    const problem = validate();
    setError(problem);
    if (problem) return;
    setBusy(true);
    try {
      await onSubmit({
        title: title.trim(),
        rule: rule.trim(),
        timesPerWeek,
        startDate,
        lengthDays,
        stake,
        missesAllowed,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const picked = template === null ? null : templates[template];
  const startLabel = `${relativeDay(startDate)} · ${formatDate(startDate)}`;
  const runs =
    lengthDays === 1 ? `Runs on ${formatDate(startDate)}.` : `Runs ${formatDate(startDate)} to ${formatDate(endDate)}.`;

  return (
    <View style={styles.form}>
      {!editing && (
        <View style={styles.templates}>
          <SectionLabel>Start from a template</SectionLabel>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
            <Chip label="Custom" selected={template === null} onPress={() => pickTemplate(null)} />
            {templates.map((t, i) => (
              <Chip key={t.name} label={t.name} selected={template === i} onPress={() => pickTemplate(i)} />
            ))}
          </ScrollView>
          {picked && (
            <InfoBox
              sections={[
                { label: 'Goal', text: picked.goal },
                { label: 'Recommendation', text: picked.recommendation },
              ]}
            />
          )}
        </View>
      )}

      <TextField
        label="Title"
        value={title}
        onChangeText={setTitle}
        placeholder="e.g. Read 20 minutes"
        maxLength={TITLE_MAX}
      />
      <TextField
        label="What counts"
        value={rule}
        onChangeText={setRule}
        placeholder="e.g. A photo of the open book, every day"
        maxLength={RULE_MAX}
        multiline
        hint="The rule everyone's photo is checked against."
      />

      <Stepper
        label="How often"
        display={howOften(timesPerWeek)}
        value={timesPerWeek}
        min={1}
        max={7}
        onChange={setTimesPerWeek}
      />
      {startLocked ? (
        <View>
          <InfoRow label="Starts" value={startLabel} />
          <Hint>{"The challenge has started, so its start date can't change."}</Hint>
        </View>
      ) : (
        <Stepper
          label="Starts"
          display={startLabel}
          value={startIn}
          min={0}
          max={MAX_START_DAYS_AHEAD}
          onChange={setStartIn}
          hint={
            startIn === 0
              ? 'Starting today: the challenge begins right away. Friends can join until midnight tonight.'
              : 'Friends can join until midnight at the end of the start day.'
          }
        />
      )}
      <Stepper
        label="Length"
        display={`${dayCount(lengthDays)} · ends ${formatDate(endDate)}`}
        value={lengthDays}
        min={MIN_LENGTH_DAYS}
        max={MAX_LENGTH_DAYS}
        onChange={changeLength}
      />
      <Stepper
        label="Misses allowed"
        display={missesAllowed === 0 ? 'None' : `${missesAllowed} ${missesAllowed === 1 ? 'miss' : 'misses'}`}
        value={missesAllowed}
        min={0}
        max={lengthDays - 1}
        onChange={setMissesAllowed}
        hint="Miss more than this and you forfeit your stake."
      />

      {editing ? (
        <View>
          <InfoRow label="Stake" value={`${initial.stake} tokens`} />
          <Hint>{"The stake can't change once a challenge exists. Delete it and create a new one instead."}</Hint>
        </View>
      ) : (
        <TextField
          label="Stake (tokens)"
          value={stakeText}
          onChangeText={(t) => setStakeText(t.replace(/[^0-9]/g, ''))}
          placeholder="e.g. 50"
          keyboardType="number-pad"
          maxLength={7}
          hint={
            balance == null
              ? 'Everyone who joins stakes the same amount.'
              : `You have ${balance} tokens. Everyone who joins stakes the same amount.`
          }
        />
      )}

      <Text style={styles.summary}>
        {editing
          ? runs
          : `${runs} Your stake moves to the pool when you tap the button, and comes back if you delete the challenge during its first day.`}
      </Text>

      {error && <ErrorText>{error}</ErrorText>}
      <Button label={submitLabel} onPress={submit} loading={busy} />
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: 22 },
  templates: { gap: 12 },
  chips: { gap: 8, paddingRight: 8 },
  summary: { fontFamily: fonts.sans, fontSize: 14, lineHeight: 20, color: colors.textSecondary },
});
