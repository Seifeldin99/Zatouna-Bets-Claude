import { router } from 'expo-router';

import { ChallengeForm } from '@/components/challenge-form';
import { ErrorText, Loading, Screen, ScreenHeader } from '@/components/ui';
import { createChallenge, myBalance } from '@/lib/challenges';
import { deviceTimeZone } from '@/lib/dates';
import { goBack } from '@/lib/navigation';
import { listTemplates } from '@/lib/templates';
import { useLoad } from '@/lib/use-load';

async function loadForm() {
  const [templates, balance] = await Promise.all([listTemplates(), myBalance()]);
  return { templates, balance };
}

export default function NewChallengeScreen() {
  const { data, error, loading } = useLoad(loadForm);

  return (
    <Screen keyboardShouldPersistTaps="handled">
      <ScreenHeader title="New challenge" back="close" onBack={() => goBack()} />
      {error && <ErrorText>{error}</ErrorText>}
      {loading && !data && <Loading />}
      {data && (
        <ChallengeForm
          templates={data.templates}
          balance={data.balance}
          submitLabel="Create and place my bet"
          onSubmit={async (fields) => {
            const id = await createChallenge(fields, deviceTimeZone());
            router.replace(`/challenge/${id}`);
          }}
        />
      )}
    </Screen>
  );
}
