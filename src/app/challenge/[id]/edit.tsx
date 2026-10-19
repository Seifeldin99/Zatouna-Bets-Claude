import { router, useLocalSearchParams } from 'expo-router';
import { useCallback } from 'react';

import { ChallengeForm } from '@/components/challenge-form';
import { ErrorText, Loading, Screen, ScreenHeader } from '@/components/ui';
import { getChallenge, updateChallenge } from '@/lib/challenges';
import { goBack } from '@/lib/navigation';
import { useLoad } from '@/lib/use-load';

export default function EditChallengeScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const load = useCallback(() => getChallenge(id), [id]);
  const { data, error, loading } = useLoad(load);

  return (
    <Screen keyboardShouldPersistTaps="handled">
      <ScreenHeader title="Edit challenge" back="close" onBack={() => goBack(`/challenge/${id}`)} />
      {error && <ErrorText>{error}</ErrorText>}
      {loading && <Loading />}
      {data && (
        <ChallengeForm
          initial={data.challenge}
          submitLabel="Save changes"
          onSubmit={async (fields) => {
            await updateChallenge(id, fields);
            router.back();
          }}
        />
      )}
    </Screen>
  );
}
