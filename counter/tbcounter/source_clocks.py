"""Reviewed timestamp crops bound to exact source fingerprints, not camera IDs."""
from .clock import OverlayClock

REVIEWED_CROPS = {
    '76877e6744222736654b6babf9678d9648444722dfa2f853a0cddc36394997fe': (.018, .075, .81, .97),
    'c6394920b50813674cdea1cb4b4ccd420e766f0baed083f7a77d2fcd03cf9076': (.06, .125, .86, 1.0),
    '2d981602b1bff72d02635febad20d39c2e7661f4e43cb05587acf78b1bc46526': (.074, .126, .88, 1.0),
    '1a64a56adf8e14925ef3bc049f9c03795e95ab37ae324c7a225a15b6a1ad5300': (.025, .10, .88, 1.0),
    '78650ba85c8da7b4e1a64c0532c2e47f08a7d9c1d31d1860f5e58d3b470cbd44': (.018, .07, .87, 1.0),
    '9030656c793ec278eb254cefe3a639bdce5f669cba4c2e424ca219160f6cbcb3': (.074, .126, .88, 1.0),
    '83164430487979bef3ee7acd5f25aefe163fae1b926e82e17db8c3006753e71f': (.025, .10, .88, 1.0),
}


def source_clock(info):
    clock = OverlayClock()
    crop = REVIEWED_CROPS.get(info.get('sourceFingerprint'))
    if crop is not None:
        clock.roi = crop
        clock.region_name = 'reviewed_caltrans_d12'
    return clock
