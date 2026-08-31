/**
 * Os efeitos de movimento do perfil.
 *
 * Diferente do tema em um ponto que muda tudo: o tema é preferência de
 * MÁQUINA e nunca sai daqui; o efeito é do PERFIL, viaja pro servidor e
 * aparece pra quem abrir o seu cartão. Por isso a lista existe também no
 * server/src/profile.ts — lá mora a permissão, aqui mora a aparência, e as
 * duas têm que andar juntas.
 *
 * Tudo é CSS: nenhum asset, nenhuma biblioteca. As keyframes estão no
 * profile.css, e todas param sob prefers-reduced-motion.
 */
export const EFEITOS = [
  {
    id: 'nenhum',
    name: 'Nenhum',
    hint: 'perfil parado',
  },
  {
    id: 'brilho',
    name: 'Brilho',
    hint: 'varredura na capa',
  },
  {
    id: 'parallax',
    name: 'Parallax',
    hint: 'a capa segue o ponteiro',
  },
  {
    id: 'pulso',
    name: 'Pulso',
    hint: 'anel respirando na foto',
  },
  {
    id: 'granulado',
    name: 'Granulado',
    hint: 'textura de filme',
  },
] as const;

export type EfeitoId = (typeof EFEITOS)[number]['id'];

export const EFEITO_PADRAO: EfeitoId = 'nenhum';

export function isEfeitoId(v: unknown): v is EfeitoId {
  return EFEITOS.some((e) => e.id === v);
}

/**
 * A classe do efeito, já validada.
 *
 * Passa pelo isEfeitoId antes de virar classe porque o valor vem do
 * SERVIDOR, e servidor é fronteira de confiança como qualquer outra — um
 * campo com lixo dentro não pode virar seletor no documento.
 */
export function classeDoEfeito(v: unknown): string {
  return isEfeitoId(v) && v !== 'nenhum' ? `capa--${v}` : '';
}
