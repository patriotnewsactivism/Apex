/**
 * North American Numbering Plan area-code table.
 *
 * Used only to FLAG obvious geography problems (a Manchester, NH lead whose
 * "phone" is a Dallas 214 number scraped from a CDN script) — never to reject
 * a number by itself, because businesses legitimately keep out-of-area
 * numbers, toll-free lines, and call-tracking numbers. Unknown area codes are
 * reported as `unknown_area_code`, not as invalid.
 */

export type NanpRegionKind = 'us_state' | 'us_territory' | 'canada' | 'caribbean' | 'toll_free' | 'premium';

export interface NanpRegion {
  code: string; // two-letter state/province/territory code, or TOLLFREE / PREMIUM / ISO country
  kind: NanpRegionKind;
}

const US: Record<string, string> = {
  AL: '205 251 256 334 483 659 938',
  AK: '907',
  AZ: '480 520 602 623 928',
  AR: '327 479 501 870',
  CA: '209 213 279 310 323 341 350 357 369 408 415 424 442 510 530 559 562 619 626 628 650 657 661 669 707 714 738 747 760 805 818 820 831 837 840 858 909 916 925 949 951',
  CO: '303 719 720 748 970 983',
  CT: '203 475 860 959',
  DE: '302',
  DC: '202 771',
  FL: '239 305 321 324 352 386 407 448 561 645 656 689 727 728 754 772 786 813 850 863 904 941 954',
  GA: '229 404 470 478 678 706 762 770 912 943',
  HI: '808',
  ID: '208 986',
  IL: '217 224 309 312 331 447 464 618 630 708 730 773 779 815 847 861 872',
  IN: '219 260 317 463 574 765 812 930',
  IA: '319 515 563 641 712',
  KS: '316 620 785 913',
  KY: '270 364 502 606 859',
  LA: '225 318 337 457 504 985',
  ME: '207',
  MD: '227 240 301 410 443 667',
  MA: '339 351 413 508 617 774 781 857 978',
  MI: '231 248 269 313 517 586 616 679 734 810 906 947 989',
  MN: '218 320 507 612 651 763 924 952',
  MS: '228 471 601 662 769',
  MO: '235 314 417 557 573 636 660 816 975',
  MT: '406',
  NE: '308 402 531',
  NV: '702 725 775',
  NH: '603',
  NJ: '201 551 609 640 732 848 856 862 908 973',
  NM: '505 575',
  NY: '212 315 329 332 347 363 516 518 585 607 624 631 646 680 716 718 838 845 914 917 929 934',
  NC: '252 336 472 704 743 828 910 919 980 984',
  ND: '701',
  OH: '216 220 234 283 326 330 380 419 436 440 513 567 614 740 937',
  OK: '405 539 572 580 918',
  OR: '458 503 541 971',
  PA: '215 223 267 272 412 445 484 570 582 610 717 724 814 835 878',
  RI: '401',
  SC: '803 821 839 843 854 864',
  SD: '605',
  TN: '423 615 629 731 865 901 931',
  TX: '210 214 254 281 325 346 361 409 430 432 469 512 682 713 726 737 806 817 830 832 903 915 936 940 945 956 972 979',
  UT: '385 435 801',
  VT: '802',
  VA: '276 434 540 571 686 703 757 804 826 948',
  WA: '206 253 360 425 509 564',
  WV: '304 681',
  WI: '262 274 353 414 534 608 715 920',
  WY: '307',
};

const US_TERRITORIES: Record<string, string> = {
  PR: '787 939', VI: '340', GU: '671', AS: '684', MP: '670',
};

const CANADA: Record<string, string> = {
  AB: '368 403 587 780 825',
  BC: '236 250 257 604 672 778',
  MB: '204 431 584',
  NB: '428 506',
  NL: '709 879',
  NS: '782 902',
  ON: '226 249 289 343 365 382 416 437 519 548 613 647 683 705 742 753 807 905 942',
  QC: '263 354 367 418 438 450 468 514 579 581 819 873',
  SK: '306 474 639',
  YT: '867',
};

const CARIBBEAN: Record<string, string> = {
  BS: '242', BB: '246', AI: '264', AG: '268', VG: '284', KY: '345', BM: '441', GD: '473', TC: '649',
  JM: '658 876', MS: '664', SX: '721', LC: '758', DM: '767', VC: '784', DO: '809 829 849', TT: '868', KN: '869',
};

const TABLE = new Map<string, NanpRegion>();
function load(group: Record<string, string>, kind: NanpRegionKind) {
  for (const [code, list] of Object.entries(group)) {
    for (const ac of list.split(/\s+/)) TABLE.set(ac, { code, kind });
  }
}
load(US, 'us_state');
load(US_TERRITORIES, 'us_territory');
load(CANADA, 'canada');
load(CARIBBEAN, 'caribbean');
for (const ac of ['800', '833', '844', '855', '866', '877', '888']) TABLE.set(ac, { code: 'TOLLFREE', kind: 'toll_free' });
TABLE.set('900', { code: 'PREMIUM', kind: 'premium' });

export function lookupAreaCode(areaCode: string): NanpRegion | null {
  return TABLE.get(areaCode) ?? null;
}

export const US_STATE_NAMES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky',
  LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota',
  OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island',
  SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  PR: 'Puerto Rico', VI: 'U.S. Virgin Islands', GU: 'Guam', AS: 'American Samoa', MP: 'Northern Mariana Islands',
};

const STATE_BY_NAME = new Map<string, string>(
  Object.entries(US_STATE_NAMES).map(([abbr, name]) => [name.toLowerCase(), abbr]),
);

/** Resolve "TX", "tx", "Texas" → "TX". Returns null when not a US state/territory. */
export function normalizeUsState(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim().replace(/\.$/, '');
  if (!v) return null;
  const upper = v.toUpperCase();
  if (US_STATE_NAMES[upper]) return upper;
  return STATE_BY_NAME.get(v.toLowerCase()) ?? null;
}

/** Area codes shared across a state line by metro overlays are rare; DC/MD/VA is the common one. */
const NEIGHBOR_TOLERANCE: Record<string, string[]> = {
  DC: ['MD', 'VA'], MD: ['DC'], VA: ['DC'],
};

export function stateMatchesRegion(state: string, region: NanpRegion): boolean {
  if (region.kind !== 'us_state' && region.kind !== 'us_territory') return false;
  if (region.code === state) return true;
  return (NEIGHBOR_TOLERANCE[state] ?? []).includes(region.code);
}
