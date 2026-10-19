// The seven preset challenges. Every challenge is made from one of them: the
// server copies the title and the rule from the template (no custom
// challenges in the first draft). The texts live in the challenge_templates
// table, so the app shows exactly what the server will save.
import { toError } from '@/lib/challenges';
import { supabase } from '@/lib/supabase';

export type Template = {
  key: string;
  title: string;
  goal: string;
  recommendation: string;
  /** What counts as one check-in; becomes the challenge rule. */
  rule: string;
};

export async function listTemplates(): Promise<Template[]> {
  const { data, error } = await supabase
    .from('challenge_templates')
    .select('key, title, goal, recommendation, rule')
    .order('position');
  if (error) throw toError(error);
  return data as Template[];
}
