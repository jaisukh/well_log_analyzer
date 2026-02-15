import lasio


def parse_las_file(file_path: str):
    las = lasio.read(file_path)

    # Depth index (works across lasio versions)
    depth = las.index.tolist()

    curves_meta = []
    curve_data = {}

    for curve in las.curves:
        name = curve.mnemonic
        unit = curve.unit
        desc = curve.descr

        curves_meta.append({
            "name": name,
            "unit": unit,
            "description": desc
        })

        # Extract curve values
        curve_data[name] = las[curve.mnemonic].tolist()

    return depth, curves_meta, curve_data


