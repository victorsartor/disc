/**
 * O catálogo dos temas — a lista que o seletor de perfil desenha e a
 * validação que o main usa antes de gravar. As cores de verdade estão no
 * themes.css; aqui só mora o que precisa existir em JavaScript.
 */
export const THEMES = [
  {
    id: 'artico',
    name: 'Ártico',
    hint: 'claro',
    // A bolinha do seletor não pode depender do tema em vigor pra se
    // desenhar — ela mostra o tema que VAI entrar, não o que está lá.
    swatch: 'linear-gradient(145deg, #ffffff, #dfe4e8)',
  },
  {
    id: 'crepusculo',
    name: 'Crepúsculo',
    hint: 'azul entardecer',
    swatch: 'linear-gradient(145deg, #5b7ba1, #27354a)',
  },
  {
    id: 'prussiano',
    name: 'Prussiano',
    hint: 'azul profundo',
    swatch: 'linear-gradient(145deg, #24365a, #0e1a2c)',
  },
  {
    id: 'abissal',
    name: 'Abissal',
    hint: 'preto tinta',
    swatch: 'linear-gradient(145deg, #16283d, #060d15)',
  },
  {
    id: 'tabaco',
    name: 'Tabaco',
    hint: 'marrom terroso',
    swatch: 'linear-gradient(145deg, #936639, #33200e)',
  },
  {
    id: 'musgo',
    name: 'Musgo',
    hint: 'verde oliva',
    swatch: 'linear-gradient(145deg, #656d4a, #1c2116)',
  },
  {
    id: 'violeta',
    name: 'Violeta',
    hint: 'roxo vibrante',
    swatch: 'linear-gradient(145deg, #9d4edd, #240046)',
  },
  {
    id: 'ametista',
    name: 'Ametista',
    hint: 'roxo profundo',
    swatch: 'linear-gradient(145deg, #7b2cbf, #10002b)',
  },
] as const;

export type ThemeId = (typeof THEMES)[number]['id'];

export const DEFAULT_THEME: ThemeId = 'abissal';

export function isThemeId(v: unknown): v is ThemeId {
  return THEMES.some((t) => t.id === v);
}
