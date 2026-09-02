import type { StatusEscolhido } from '../types';

/**
 * O catálogo dos status — rótulo e cor de cada um, num lugar só.
 *
 * Mora aqui, e não dentro de um componente, porque três telas diferentes
 * desenham a mesma bolinha: a sua linha no rodapé da coluna, a lista de
 * quem está online e o seletor dentro do perfil.
 */
export const STATUS = {
  disponivel: { label: 'Disponível', cor: 'var(--ok)' },
  ausente: { label: 'Ausente', cor: 'var(--live)' },
  invisivel: { label: 'Invisível', cor: 'var(--lavender)' },
  offline: { label: 'Off-line', cor: 'var(--lavender)' },
} as const;

/**
 * O que o seletor oferece, com a explicação de cada um.
 *
 * São três e não quatro: 'offline' é algo que acontece com você quando o
 * app fecha, não uma opção que dê pra escolher.
 */
export const ESCOLHAS: { id: StatusEscolhido; dica: string }[] = [
  { id: 'disponivel', dica: 'Vira "Ausente" sozinho depois de 10 min de microfone mudo' },
  { id: 'ausente', dica: 'Fica ausente mesmo com o microfone aberto' },
  { id: 'invisivel', dica: 'Você aparece off-line pros outros' },
];
