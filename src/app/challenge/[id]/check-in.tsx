import { CameraView, useCameraPermissions } from 'expo-camera';
import { useLocalSearchParams } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Image, Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { Button, Card, ErrorText, Hint, InfoBox, Loading, Screen, ScreenHeader, TextField } from '@/components/ui';
import { getChallenge } from '@/lib/challenges';
import { NOTE_MAX, type Photo, type SubmitStage, type Verdict, submitCheckIn } from '@/lib/check-ins';
import { goBack } from '@/lib/navigation';
import { useLoad } from '@/lib/use-load';
import { colors, fonts, radius } from '@/theme';

type Step =
  | { kind: 'camera' }
  | { kind: 'review'; photo: Photo }
  | { kind: 'sending'; photo: Photo; stage: SubmitStage }
  | { kind: 'result'; verdict: Verdict }
  | { kind: 'failed'; photo: Photo; message: string };

const stageTitles: Record<SubmitStage, string> = {
  preparing: 'Preparing your photo…',
  uploading: 'Uploading…',
  checking: 'The AI is looking at your photo…',
};

export default function CheckInScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const load = useCallback(() => getChallenge(id), [id]);
  const { data } = useLoad(load);
  const [step, setStep] = useState<Step>({ kind: 'camera' });
  const [note, setNote] = useState('');
  const back = () => goBack(`/challenge/${id}`);

  async function send(photo: Photo) {
    setStep({ kind: 'sending', photo, stage: 'preparing' });
    try {
      const verdict = await submitCheckIn(id, photo, note, (stage) => setStep({ kind: 'sending', photo, stage }));
      setStep({ kind: 'result', verdict });
    } catch (e) {
      setStep({ kind: 'failed', photo, message: e instanceof Error ? e.message : String(e) });
    }
  }

  return (
    <Screen keyboardShouldPersistTaps="handled">
      <ScreenHeader title={data?.challenge.title ?? 'Check in'} back="close" onBack={back} />

      {step.kind === 'camera' && (
        <>
          {data && <InfoBox sections={[{ label: 'What counts', text: data.challenge.rule }]} />}
          <Camera onPhoto={(photo) => setStep({ kind: 'review', photo })} />
        </>
      )}

      {step.kind === 'review' && (
        <>
          <Image source={{ uri: step.photo.uri }} style={styles.preview} accessibilityLabel="Your photo" />
          <TextField
            label="Note (optional)"
            value={note}
            onChangeText={setNote}
            multiline
            maxLength={NOTE_MAX}
            placeholder="What's in the photo?"
            hint={`${note.length} of ${NOTE_MAX} characters. The AI reads it, but the photo is the proof.`}
          />
          <Button label="Send for checking" onPress={() => void send(step.photo)} />
          <Button label="Retake" variant="secondary" onPress={() => setStep({ kind: 'camera' })} />
        </>
      )}

      {step.kind === 'sending' && (
        <Card style={styles.center}>
          <Loading />
          <Text style={styles.stageTitle}>{stageTitles[step.stage]}</Text>
          <Text style={styles.stageText}>This takes up to a minute. Keep the app open.</Text>
        </Card>
      )}

      {step.kind === 'result' && step.verdict.state === 'accepted' && (
        <>
          <Card style={styles.center}>
            <Text style={styles.resultTitle}>Accepted</Text>
            <Text style={styles.reason}>{step.verdict.reason}</Text>
            <Text style={styles.stageText}>Today counts. See you tomorrow.</Text>
          </Card>
          <Button label="Done" onPress={back} />
        </>
      )}

      {step.kind === 'result' && step.verdict.state !== 'accepted' && (
        <>
          <Card style={styles.center}>
            <Text style={[styles.resultTitle, styles.resultTitleRejected]}>Not accepted</Text>
            <Text style={styles.reason}>{step.verdict.reason}</Text>
          </Card>
          <Button label="Retry with a new photo" onPress={() => setStep({ kind: 'camera' })} />
          <Hint>
            You can retry as often as you like until midnight. Think the AI got it wrong? Calling the referee comes
            in the next update.
          </Hint>
          <Button label="Close" variant="secondary" onPress={back} />
        </>
      )}

      {step.kind === 'failed' && (
        <>
          <ErrorText>{step.message}</ErrorText>
          <Button label="Try again" onPress={() => setStep({ kind: 'review', photo: step.photo })} />
          <Button label="Close" variant="secondary" onPress={back} />
        </>
      )}
    </Screen>
  );
}

/** The live camera with a shutter button. Photos come from here only, never the gallery (story 5.1). */
function Camera({ onPhoto }: { onPhoto: (photo: Photo) => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const camera = useRef<CameraView>(null);
  const [ready, setReady] = useState(false);
  const [snapping, setSnapping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!permission) return <Loading />;

  if (!permission.granted) {
    return (
      <Card style={styles.center}>
        <Text style={styles.stageTitle}>Zatouna needs your camera</Text>
        <Text style={styles.stageText}>
          Check-in photos are taken right here, in the app, so nobody can send an old picture.
        </Text>
        {permission.canAskAgain ? (
          <Button label="Allow the camera" onPress={() => void requestPermission()} />
        ) : (
          <Button label="Open phone settings" onPress={() => void Linking.openSettings()} />
        )}
      </Card>
    );
  }

  async function snap() {
    if (!camera.current || snapping) return;
    setSnapping(true);
    setError(null);
    try {
      const picture = await camera.current.takePictureAsync({ quality: 0.85 });
      onPhoto({ uri: picture.uri, width: picture.width, height: picture.height });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSnapping(false);
    }
  }

  return (
    <>
      <View style={styles.cameraBox}>
        <CameraView
          ref={camera}
          style={styles.camera}
          facing="back"
          animateShutter={false}
          onCameraReady={() => setReady(true)}
        />
      </View>
      {error && <ErrorText>{error}</ErrorText>}
      <View style={styles.shutterRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Take the photo"
          onPress={() => void snap()}
          disabled={!ready || snapping}
          style={({ pressed }) => [styles.shutter, (!ready || snapping) && styles.shutterOff, pressed && styles.shutterPressed]}>
          <View style={styles.shutterInner} />
        </Pressable>
      </View>
      <Hint>{"Take the photo now. Old pictures from the gallery can't be used."}</Hint>
    </>
  );
}

const styles = StyleSheet.create({
  cameraBox: {
    width: '100%',
    aspectRatio: 3 / 4,
    borderRadius: radius.card,
    overflow: 'hidden',
    backgroundColor: colors.surface,
  },
  camera: { flex: 1 },
  shutterRow: { alignItems: 'center' },
  shutter: {
    width: 76,
    height: 76,
    borderRadius: radius.pill,
    borderWidth: 4,
    borderColor: colors.text,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterInner: { width: 58, height: 58, borderRadius: radius.pill, backgroundColor: colors.text },
  shutterOff: { opacity: 0.4 },
  shutterPressed: { transform: [{ scale: 0.94 }] },
  preview: { width: '100%', aspectRatio: 3 / 4, borderRadius: radius.card, backgroundColor: colors.surface },
  center: { alignItems: 'center', gap: 12 },
  stageTitle: { fontFamily: fonts.sansSemiBold, fontSize: 18, color: colors.text, textAlign: 'center' },
  stageText: { fontFamily: fonts.sans, fontSize: 14, lineHeight: 20, color: colors.textSecondary, textAlign: 'center' },
  resultTitle: { fontFamily: fonts.serif, fontSize: 32, color: colors.accent, textAlign: 'center' },
  resultTitleRejected: { color: colors.danger },
  reason: { fontFamily: fonts.sansMedium, fontSize: 16, lineHeight: 23, color: colors.text, textAlign: 'center' },
});
