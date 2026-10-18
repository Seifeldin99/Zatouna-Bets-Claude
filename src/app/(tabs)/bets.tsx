import { EmptyState, Screen, Title } from '@/components/ui';

export default function BetsScreen() {
  return (
    <Screen>
      <Title>Challenges</Title>
      <EmptyState
        title="You haven't joined any challenges yet"
        body="When you create or join a challenge, its progress and your daily check-in will be here."
      />
    </Screen>
  );
}
