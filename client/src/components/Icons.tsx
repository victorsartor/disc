interface Props {
  size?: number;
}

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
});

export const IconSpeaker = ({ size = 16 }: Props) => (
  <svg {...base(size)}>
    <path d="M11 5 6 9H2v6h4l5 4V5Z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7" />
    <path d="M19 5a9 9 0 0 1 0 14" />
  </svg>
);

export const IconMic = ({ size = 16 }: Props) => (
  <svg {...base(size)}>
    <rect x="9" y="2" width="6" height="11" rx="3" />
    <path d="M5 10a7 7 0 0 0 14 0" />
    <path d="M12 17v5" />
  </svg>
);

export const IconMicOff = ({ size = 16 }: Props) => (
  <svg {...base(size)}>
    <path d="M2 2l20 20" />
    <path d="M9 9v1a3 3 0 0 0 5 2" />
    <path d="M15 10V5a3 3 0 0 0-5.6-1.5" />
    <path d="M5 10a7 7 0 0 0 10.6 6" />
    <path d="M19 10a7 7 0 0 1-.6 2.8" />
    <path d="M12 17v5" />
  </svg>
);

export const IconHeadphones = ({ size = 16 }: Props) => (
  <svg {...base(size)}>
    <path d="M3 16v-4a9 9 0 0 1 18 0v4" />
    <path d="M21 17a2 2 0 0 1-2 2h-1v-6h1a2 2 0 0 1 2 2Z" />
    <path d="M3 17a2 2 0 0 0 2 2h1v-6H5a2 2 0 0 0-2 2Z" />
  </svg>
);

export const IconHeadphonesOff = ({ size = 16 }: Props) => (
  <svg {...base(size)}>
    <path d="M2 2l20 20" />
    <path d="M3 16v-4a9 9 0 0 1 13.4-7.8" />
    <path d="M21 15v2a2 2 0 0 1-2 2h-1v-6h1" />
    <path d="M3 17a2 2 0 0 0 2 2h1v-6H5a2 2 0 0 0-2 2Z" />
  </svg>
);

export const IconScreen = ({ size = 16 }: Props) => (
  <svg {...base(size)}>
    <rect x="2" y="3" width="20" height="14" rx="2" />
    <path d="M8 21h8" />
    <path d="M12 17v4" />
  </svg>
);

export const IconLeave = ({ size = 16 }: Props) => (
  <svg {...base(size)}>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="m16 17 5-5-5-5" />
    <path d="M21 12H9" />
  </svg>
);

export const IconBroadcast = ({ size = 16 }: Props) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="2" />
    <path d="M16.2 7.8a6 6 0 0 1 0 8.4" />
    <path d="M7.8 16.2a6 6 0 0 1 0-8.4" />
    <path d="M19.1 4.9a10 10 0 0 1 0 14.2" />
    <path d="M4.9 19.1a10 10 0 0 1 0-14.2" />
  </svg>
);

export const IconSettings = ({ size = 16 }: Props) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
  </svg>
);
