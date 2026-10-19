import { router } from 'expo-router';

import { ChallengeForm } from '@/components/challenge-form';
import { Screen, ScreenHeader } from '@/components/ui';
import { createChallenge, myBalance } from '@/lib/challenges';
import { deviceTimeZone } from '@/lib/dates';
import { goBack } from '@/lib/navigation';
import { useLoad } from '@/lib/use-load';

export default function NewChallengeScreen() {
  const { data: balance } = useLoad(myBalance);

  return (
    <Screen keyboardShouldPersistTaps="handled">
      <ScreenHeader title="New challenge" back="close" onBack={() => goBack()} />
      <ChallengeForm
        balance={balance}
        submitLabel="Create and place my bet"
        onSubmit={async (fields) => {
          const id = await createChallenge(fields, deviceTimeZone());
          router.replace(`/challenge/${id}`);
        }}
      />
    </Screen>
  );
}
