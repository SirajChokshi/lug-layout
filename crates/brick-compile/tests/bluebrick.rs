use std::path::Path;

use brick_compile::bluebrick::{
    read_bbm, AreaCell, BlueBrickError, BlueBrickMap, Brick, BrickLayer, BrickRef, CellPoint,
    Color, ConnectionRef, DecimalText, DistanceUnit, Font, Group, IdHolder, IndexLabels, ItemId,
    Layer, LayerContent, MapDate, Point, ReadIssue, RulerEnd, RulerLayer, RulerShape,
    TextAlignment, TextLayer,
};

fn fixture(name: &str) -> BlueBrickMap {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/test-fixtures/bluebrick")
        .join(name);
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    read_bbm(&bytes).unwrap_or_else(|e| panic!("{name}: {e}"))
}

fn read(source: &str) -> Result<BlueBrickMap, BlueBrickError> {
    read_bbm(source.as_bytes())
}

fn kind(layer: &Layer) -> &'static str {
    match layer.content {
        LayerContent::Grid(_) => "grid",
        LayerContent::Brick(_) => "brick",
        LayerContent::Area(_) => "area",
        LayerContent::Text(_) => "text",
        LayerContent::Ruler(_) => "ruler",
    }
}

fn bricks(map: &BlueBrickMap, layer: usize) -> &BrickLayer {
    match &map.layers[layer].content {
        LayerContent::Brick(bricks) => bricks,
        _ => panic!("layer {layer} isn't a brick layer"),
    }
}

fn texts(map: &BlueBrickMap, layer: usize) -> &TextLayer {
    match &map.layers[layer].content {
        LayerContent::Text(texts) => texts,
        _ => panic!("layer {layer} isn't a text layer"),
    }
}

fn rulers(map: &BlueBrickMap, layer: usize) -> &RulerLayer {
    match &map.layers[layer].content {
        LayerContent::Ruler(rulers) => rulers,
        _ => panic!("layer {layer} isn't a ruler layer"),
    }
}

fn link(map: &BlueBrickMap, at: ConnectionRef) -> Option<ConnectionRef> {
    bricks(map, at.layer).bricks[at.brick].connections[at.connection].link
}

fn at(layer: usize, brick: usize, connection: usize) -> ConnectionRef {
    ConnectionRef {
        layer,
        brick,
        connection,
    }
}

fn named(name: &str) -> Color {
    Color::Named {
        name: name.to_string(),
    }
}

fn decimal(text: &DecimalText) -> &str {
    text.as_str()
}

struct Expected {
    file: &'static str,
    layers: &'static [&'static str],
    bricks: usize,
    linked_connections: usize,
    groups: usize,
    texts: usize,
    rulers: usize,
}

#[test]
fn every_committed_map_reads_whole_with_reciprocal_links() {
    let expected = [
        Expected {
            file: "sample_track01.bbm",
            layers: &["grid", "brick"],
            bricks: 56,
            linked_connections: 114,
            groups: 0,
            texts: 0,
            rulers: 0,
        },
        Expected {
            file: "queue.bbm",
            layers: &["grid", "brick"],
            bricks: 198,
            linked_connections: 404,
            groups: 0,
            texts: 0,
            rulers: 0,
        },
        Expected {
            file: "tight-corner.bbm",
            layers: &["grid", "brick", "brick", "brick", "brick", "brick", "text"],
            bricks: 304,
            linked_connections: 532,
            groups: 44,
            texts: 13,
            rulers: 0,
        },
        Expected {
            file: "fordyce-2026.bbm",
            layers: &["grid", "brick", "brick", "text", "ruler"],
            bricks: 940,
            linked_connections: 1000,
            groups: 0,
            texts: 3,
            rulers: 5,
        },
        Expected {
            file: "synthetic-yard.bbm",
            layers: &["grid", "brick", "brick", "area", "text", "ruler"],
            bricks: 5,
            linked_connections: 4,
            groups: 2,
            texts: 1,
            rulers: 2,
        },
    ];
    for expected in expected {
        let map = fixture(expected.file);
        let layer_kinds: Vec<_> = map.layers.iter().map(kind).collect();
        assert_eq!(layer_kinds, expected.layers, "{}", expected.file);
        assert_eq!(map.issues, [], "{}", expected.file);
        let (mut bricks, mut linked, mut groups, mut texts, mut rulers) = (0, 0, 0, 0, 0);
        for (layer, content) in map.layers.iter().enumerate() {
            match &content.content {
                LayerContent::Brick(held) => {
                    bricks += held.bricks.len();
                    groups += held.groups.len();
                    for (brick, piece) in held.bricks.iter().enumerate() {
                        for (connection, end) in piece.connections.iter().enumerate() {
                            if let Some(to) = end.link {
                                linked += 1;
                                assert_ne!(to, at(layer, brick, connection), "{}", expected.file);
                                assert_eq!(
                                    link(&map, to),
                                    Some(at(layer, brick, connection)),
                                    "{}",
                                    expected.file
                                );
                            }
                        }
                    }
                }
                LayerContent::Text(held) => {
                    texts += held.texts.len();
                    groups += held.groups.len();
                }
                LayerContent::Ruler(held) => {
                    rulers += held.rulers.len();
                    groups += held.groups.len();
                }
                LayerContent::Grid(_) | LayerContent::Area(_) => {}
            }
        }
        assert_eq!(
            (bricks, linked, groups, texts, rulers),
            (
                expected.bricks,
                expected.linked_connections,
                expected.groups,
                expected.texts,
                expected.rulers
            ),
            "{}",
            expected.file
        );
    }
}

#[test]
fn real_maps_keep_what_their_authors_wrote() {
    let track = fixture("sample_track01.bbm");
    let first = &bricks(&track, 1).bricks[0];
    assert_eq!(first.id.map(|id| id.value()), Some(33));
    assert_eq!(first.part, "2865.8");
    assert_eq!(
        [
            &first.area.x,
            &first.area.y,
            &first.area.width,
            &first.area.height
        ]
        .map(decimal),
        ["255.4999", "96.00031", "17", "8"]
    );
    assert_eq!(link(&track, at(1, 0, 0)), Some(at(1, 24, 1)));
    assert_eq!(link(&track, at(1, 0, 1)), Some(at(1, 18, 0)));

    let queue = fixture("queue.bbm");
    let third_party = bricks(&queue, 1)
        .bricks
        .iter()
        .find(|brick| brick.id.map(|id| id.value()) == Some(11))
        .expect("brick 11");
    assert_eq!(third_party.part, "TB CT R104BC.8");
    assert_eq!(decimal(&third_party.orientation), "1012.5");

    let corner = fixture("tight-corner.bbm");
    let tracks = bricks(&corner, 4);
    assert_eq!(corner.layers[4].name, "Tracks");
    assert_eq!(tracks.groups[1].id.value(), 131);
    assert_eq!(tracks.groups[1].parent, Some(0));
    assert_eq!(tracks.groups[0].id.value(), 226);
    assert_eq!(tracks.bricks[1].group, Some(1));

    let fordyce = fixture("fordyce-2026.bbm");
    assert_eq!(fordyce.properties.author, "Aaron Kimbrell");
    assert_eq!(fordyce.properties.lug, "ArkLUG");
    assert_eq!(fordyce.properties.event, "Fordyce 2026");
    assert_eq!(
        fordyce.properties.date,
        MapDate {
            year: 2026,
            month: 4,
            day: 24
        }
    );
    assert_eq!(texts(&fordyce, 3).texts[0].text, "Nikki");
    let ruler = &rulers(&fordyce, 4).rulers[0];
    assert_eq!(ruler.unit, DistanceUnit::Feet);
    let RulerShape::Linear {
        from,
        to,
        from_attachment,
        to_attachment,
        offset,
        ..
    } = &ruler.shape
    else {
        panic!("the first Fordyce ruler is linear");
    };
    assert_eq!(
        [&from.x, &from.y, &to.x, &to.y].map(decimal),
        ["1440", "64", "64", "64"]
    );
    assert_eq!((from_attachment, to_attachment), (&None, &None));
    assert_eq!(decimal(offset), "4");
}

#[test]
fn the_synthetic_yard_reads_every_kind_of_layer() {
    let map = fixture("synthetic-yard.bbm");
    assert_eq!(map.version, 9);
    assert_eq!(map.properties.event, "Yard & siding test");
    assert_eq!(
        map.properties.comment,
        "Built by hand from official LDraw parts:\n3811 baseplates, 53401 straights and a 53400 curve."
    );
    assert_eq!(
        map.properties.date,
        MapDate {
            year: 2024,
            month: 2,
            day: 29
        }
    );
    assert_eq!(
        map.properties.background,
        Some(Color::Argb { argb: 0xff2a_6e3c })
    );

    let LayerContent::Grid(grid) = &map.layers[0].content else {
        panic!("layer 0 is the grid");
    };
    assert_eq!((grid.cell_size, grid.subdivisions), (32, 4));
    assert_eq!(grid.show_lines, Some(false));
    assert_eq!(grid.sub_lines.thickness, 0.5);
    assert_eq!(
        (grid.cell_index.columns, grid.cell_index.rows),
        (IndexLabels::Numbers, IndexLabels::Letters)
    );
    assert_eq!(grid.cell_index.origin, CellPoint { x: -1, y: 2 });
    assert!(grid.cell_index.font.bold && !grid.cell_index.font.italic);
    assert_eq!(grid.cell_index.color, named("DarkSlateGray"));

    let plates = &map.layers[1];
    assert_eq!(plates.opacity, 80);
    let hull = plates.hull.as_ref().expect("v9 layers carry hulls");
    assert!(hull.visible);
    assert_eq!(
        (hull.color.clone(), hull.thickness),
        (Color::Argb { argb: 0xff00_00ff }, 3)
    );
    assert_eq!(bricks(&map, 1).bricks[1].part, "3811.2");

    let track = bricks(&map, 2);
    assert!(track.show_elevation);
    assert_eq!(
        track.groups,
        [
            Group {
                id: ItemId::new(40),
                part: None,
                parent: Some(1)
            },
            Group {
                id: ItemId::new(41),
                part: Some("YARD-LEAD.KIT".to_string()),
                parent: None
            },
        ]
    );
    let groups: Vec<_> = track.bricks.iter().map(|brick| brick.group).collect();
    assert_eq!(groups, [Some(0), Some(0), Some(1)]);
    let curve: &Brick = &track.bricks[2];
    assert_eq!(curve.part, "53400.72");
    assert_eq!(decimal(&curve.orientation), "-22.5");
    assert_eq!(decimal(&curve.altitude), "9.6");
    assert_eq!(decimal(&curve.area.x), "39.31371");
    assert_eq!(curve.active_connection, 1);
    assert_eq!(link(&map, at(2, 0, 0)), None);
    assert_eq!(link(&map, at(2, 0, 1)), Some(at(2, 1, 0)));
    assert_eq!(link(&map, at(2, 1, 1)), Some(at(2, 2, 0)));
    assert_eq!(link(&map, at(2, 2, 1)), None);

    let zones = &map.layers[3];
    assert!(!zones.visible);
    assert_eq!(zones.opacity, 30);
    let LayerContent::Area(area) = &zones.content else {
        panic!("layer 3 is the area layer");
    };
    assert_eq!(area.cell_size, 8);
    assert_eq!(
        area.cells,
        [
            AreaCell {
                x: -1,
                y: 3,
                rgb: 0x22_8b22
            },
            AreaCell {
                x: 0,
                y: 3,
                rgb: 0x22_8b22
            },
            AreaCell {
                x: 0,
                y: 4,
                rgb: 0xff_a500
            },
        ]
    );

    let label = &texts(&map, 4).texts[0];
    assert_eq!(label.text, "Yard lead\n<siding>");
    assert_eq!(decimal(&label.orientation), "-90");
    assert_eq!(label.alignment, TextAlignment::Far);
    assert_eq!(label.color, Color::Argb { argb: 0xff12_3456 });
    assert_eq!(
        label.font,
        Font {
            family: "Segoe UI".to_string(),
            size: 10.5,
            bold: true,
            italic: true,
            underline: false,
            strikeout: false,
        }
    );

    let measures = rulers(&map, 5);
    let linear = &measures.rulers[0];
    assert_eq!(linear.unit, DistanceUnit::StraightTrack);
    assert_eq!(linear.guideline.dash_pattern, [2.0, 4.0]);
    assert!(linear.show_distance && !linear.show_unit);
    assert_eq!(
        linear.shape,
        RulerShape::Linear {
            from: Point {
                x: DecimalText::parse("8").expect("decimal"),
                y: DecimalText::parse("16").expect("decimal"),
            },
            to: Point {
                x: DecimalText::parse("56").expect("decimal"),
                y: DecimalText::parse("16").expect("decimal"),
            },
            from_attachment: Some(BrickRef { layer: 2, brick: 0 }),
            to_attachment: None,
            offset: DecimalText::parse("-6").expect("decimal"),
            allow_offset: true,
        }
    );
    let circular = &measures.rulers[1];
    assert!(circular.measure_font.underline);
    assert!(circular.guideline.dash_pattern.is_empty());
    let RulerShape::Circular {
        radius, attachment, ..
    } = &circular.shape
    else {
        panic!("the second ruler is circular");
    };
    assert_eq!(decimal(radius), "12");
    assert_eq!(*attachment, Some(BrickRef { layer: 1, brick: 1 }));
}

const BLACK: &str = "<IsKnownColor>true</IsKnownColor><Name>Black</Name>";

fn header(version: u32, event_element: &str) -> String {
    let comment = if version >= 1 {
        "<Comment>c</Comment>"
    } else {
        ""
    };
    format!(
        "<Version>{version}</Version><Author>a</Author><LUG>l</LUG>\
         <{event_element}>e</{event_element}><Date><Day>1</Day><Month>2</Month><Year>2003</Year></Date>{comment}"
    )
}

fn map_of(version: u32, layers: &str) -> String {
    format!(
        "<?xml version=\"1.0\"?><Map>{}<Layers>{layers}</Layers></Map>",
        header(version, "Event")
    )
}

fn connection(id: u64, linked: Option<u64>) -> String {
    let linked = linked.map(|id| id.to_string()).unwrap_or_default();
    format!("<Connexion id=\"{id}\"><LinkedTo>{linked}</LinkedTo></Connexion>")
}

fn v9_brick(id: u64, group: Option<u64>, connections: &[String]) -> String {
    let group = group.map(|id| id.to_string()).unwrap_or_default();
    format!(
        "<Brick id=\"{id}\"><DisplayArea><X>0</X><Y>0</Y><Width>1</Width><Height>1</Height></DisplayArea>\
         <MyGroup>{group}</MyGroup><PartNumber>3001.4</PartNumber><Orientation>0</Orientation>\
         <ActiveConnectionPointIndex>0</ActiveConnectionPointIndex><Altitude>0</Altitude>\
         <Connexions count=\"{}\">{}</Connexions></Brick>",
        connections.len(),
        connections.concat()
    )
}

fn v9_brick_layer(id: u64, bricks: &[String], groups: &str) -> String {
    format!(
        "<Layer type=\"brick\" id=\"{id}\"><Name>b</Name><Visible>true</Visible><Transparency>100</Transparency>\
         <HullProperties isVisible=\"false\"><hullColor>{BLACK}</hullColor><hullThickness>1</hullThickness></HullProperties>\
         <DisplayBrickElevation>false</DisplayBrickElevation><Bricks>{}</Bricks><Groups>{groups}</Groups></Layer>",
        bricks.concat()
    )
}

fn group(id: u64, parent: Option<u64>) -> String {
    let parent = parent.map(|id| id.to_string()).unwrap_or_default();
    format!("<Group id=\"{id}\"><PartNumber /><MyGroup>{parent}</MyGroup></Group>")
}

#[test]
fn older_formats_read_through_their_version_gates() {
    let v4_brick = "<Brick><DisplayArea><X>1.5</X><Y>2</Y><Width>8</Width><Height>4</Height></DisplayArea>\
        <PartNumber>2865.8</PartNumber><Orientation>90</Orientation><ActiveConnectionPointIndex>1</ActiveConnectionPointIndex>\
        <Altitude>0</Altitude><Connexions count=\"1\"><Connexion id=\"7\"><LinkedTo /></Connexion></Connexions></Brick>";
    let v4 = format!(
        "<Map>{}<Layers>\
         <Layer type=\"brick\"><Name>Track</Name><Visible>true</Visible><Bricks>{v4_brick}</Bricks></Layer>\
         <Layer type=\"area\"><Name>Zones</Name><Visible>true</Visible><Transparency>40</Transparency><AreaCellSize>32</AreaCellSize><Areas /></Layer>\
         <Layer type=\"text\"><Name>Labels</Name><Visible>true</Visible><TextCells><TextCell>\
         <DisplayArea><X>0</X><Y>0</Y><Width>1</Width><Height>1</Height></DisplayArea><Text>t</Text><Orientation>0</Orientation>\
         <FontColor>{BLACK}</FontColor><Font><FontFamily>Arial</FontFamily><Size>9</Size></Font><TextAlignment>Near</TextAlignment>\
         </TextCell></TextCells></Layer></Layers></Map>",
        header(4, "Show")
    );
    let map = read(&v4).expect("a version 4 map reads");
    assert_eq!(map.version, 4);
    assert_eq!(map.properties.event, "e");
    assert!(map
        .layers
        .iter()
        .all(|layer| layer.id.is_none() && layer.hull.is_none()));
    assert_eq!(
        map.layers
            .iter()
            .map(|layer| layer.opacity)
            .collect::<Vec<_>>(),
        [100, 40, 100]
    );
    let track = bricks(&map, 0);
    assert!(track.groups.is_empty());
    assert_eq!((track.bricks[0].id, track.bricks[0].group), (None, None));
    assert_eq!(texts(&map, 2).texts[0].font.family, "Arial");
    assert!(!texts(&map, 2).texts[0].font.bold);

    let v2 = format!(
        "<Map>{}<Layers><Layer type=\"brick\"><Name>b</Name><Visible>false</Visible><Bricks>\
         <Brick><DisplayArea><X>0</X><Y>0</Y><Width>1</Width><Height>1</Height></DisplayArea>\
         <PartNumber>3001.4</PartNumber><Orientation>0</Orientation><ActiveConnectionPointIndex>0</ActiveConnectionPointIndex>\
         <Connexions count=\"0\" /></Brick></Bricks></Layer></Layers></Map>",
        header(2, "Show")
    );
    let map = read(&v2).expect("a version 2 map reads");
    assert_eq!(decimal(&bricks(&map, 0).bricks[0].altitude), "0");

    let v0 = format!("<Map>{}<Layers /></Map>", header(0, "Show"));
    assert_eq!(
        read(&v0).expect("a version 0 map reads").properties.comment,
        ""
    );

    let v8 = map_of(
        8,
        "<Layer type=\"brick\" id=\"5\"><Name>b</Name><Visible>true</Visible><Transparency>60</Transparency>\
         <Bricks /><Groups /></Layer>",
    );
    let map = read(&v8).expect("a version 8 map reads");
    assert_eq!(map.layers[0].id.map(|id| id.value()), Some(5));
    assert_eq!(map.layers[0].hull, None);
    assert!(!bricks(&map, 0).show_elevation);

    let missing_group = map_of(
        5,
        "<Layer type=\"brick\"><Name>b</Name><Visible>true</Visible><Transparency>100</Transparency><Bricks>\
         <Brick><DisplayArea><X>0</X><Y>0</Y><Width>1</Width><Height>1</Height></DisplayArea>\
         <PartNumber>3001.4</PartNumber><Orientation>0</Orientation><ActiveConnectionPointIndex>0</ActiveConnectionPointIndex>\
         <Altitude>0</Altitude><Connexions count=\"0\" /></Brick></Bricks><Groups /></Layer>",
    );
    assert_eq!(
        read(&missing_group).map(|_| ()),
        Err(BlueBrickError::Malformed {
            path: "Map/Layers/Layer[1]/Bricks/Brick[1]".to_string(),
            problem: "has no <MyGroup>".to_string(),
        })
    );
}

#[test]
fn files_that_are_not_readable_maps_are_rejected_with_the_reason() {
    let plain = map_of(9, "");
    assert!(read(&plain).is_ok());
    let cases: [(String, &str); 9] = [
        ("<Map><Version>9</Version>".to_string(), "notXml"),
        (
            "<Layout><Version>9</Version></Layout>".to_string(),
            "notMap",
        ),
        ("<Map><Author>a</Author></Map>".to_string(), "notMap"),
        (
            plain.replace("<Version>9</Version>", "<Version>10</Version>"),
            "newerVersion",
        ),
        (plain.replace("<Day>1</Day>", "<Day>30</Day>"), "malformed"),
        (plain.replace("<Layers></Layers>", ""), "malformed"),
        (
            map_of(9, &v9_brick_layer(1, &[v9_brick(2, None, &[])], "")).replace(
                "<Orientation>0</Orientation>",
                "<Orientation>NaN</Orientation>",
            ),
            "malformed",
        ),
        (
            map_of(9, &v9_brick_layer(1, &[], "")).replace(
                "<Transparency>100</Transparency>",
                "<Transparency>101</Transparency>",
            ),
            "malformed",
        ),
        (
            map_of(9, &v9_brick_layer(1, &[v9_brick(2, None, &[])], ""))
                .replace("<Brick id=\"2\">", "<Brick id=\"-2\">"),
            "malformed",
        ),
    ];
    for (source, expected) in cases {
        let error = read(&source).expect_err(&source);
        assert_eq!(error.kind(), expected, "{source}: {error}");
    }
    assert_eq!(
        read(&plain.replace("<Version>9</Version>", "<Version>10</Version>"))
            .expect_err("version 10")
            .to_string(),
        "this map was saved by a newer BlueBrick (data version 10); this reader knows versions up to 9"
    );
    let nan = map_of(9, &v9_brick_layer(1, &[v9_brick(2, None, &[])], "")).replace(
        "<Orientation>0</Orientation>",
        "<Orientation>NaN</Orientation>",
    );
    assert_eq!(
        read(&nan).expect_err("NaN orientation"),
        BlueBrickError::Malformed {
            path: "Map/Layers/Layer[1]/Bricks/Brick[1]/Orientation".to_string(),
            problem: "\"NaN\" isn't a finite decimal".to_string(),
        }
    );
}

#[test]
fn inconsistent_references_are_reported_and_never_guessed() {
    let track = v9_brick_layer(
        1,
        &[
            v9_brick(
                10,
                Some(50),
                &[connection(100, Some(101)), connection(102, Some(999))],
            ),
            v9_brick(
                11,
                Some(51),
                &[connection(101, Some(100)), connection(103, Some(100))],
            ),
            v9_brick(
                12,
                Some(52),
                &[connection(104, Some(105)), connection(105, Some(104))],
            ),
            v9_brick(
                13,
                Some(53),
                &[connection(105, None), connection(106, Some(106))],
            ),
        ],
        &[
            group(50, Some(51)),
            group(51, Some(50)),
            group(52, None),
            group(52, Some(50)),
        ]
        .concat(),
    );
    let measures = format!(
        "<Layer type=\"ruler\" id=\"2\"><Name>r</Name><Visible>true</Visible><Transparency>100</Transparency>\
         <HullProperties isVisible=\"false\"><hullColor>{BLACK}</hullColor><hullThickness>1</hullThickness></HullProperties>\
         <RulerItems><CircularRuler><DisplayArea><X>0</X><Y>0</Y><Width>2</Width><Height>2</Height></DisplayArea><MyGroup />\
         <Color>{BLACK}</Color><LineThickness>1</LineThickness><DisplayDistance>true</DisplayDistance><DisplayUnit>true</DisplayUnit>\
         <GuidelineColor>{BLACK}</GuidelineColor><GuidelineThickness>1</GuidelineThickness><GuidelineDashPattern />\
         <Unit>1</Unit><MeasureFont><FontFamily>Arial</FontFamily><Size>8</Size><Style>Regular</Style></MeasureFont>\
         <MeasureFontColor>{BLACK}</MeasureFontColor><Center><X>1</X><Y>1</Y></Center><Radius>1</Radius>\
         <AttachedBrick>77</AttachedBrick></CircularRuler></RulerItems><Groups /></Layer>"
    );
    let source = map_of(
        9,
        &format!("<Layer type=\"flex\" id=\"9\" />{track}{measures}"),
    );
    let map = read(&source).expect("a map with broken references still reads");
    assert_eq!(map.layers.len(), 2);
    assert_eq!(
        map.issues,
        [
            ReadIssue::SkippedLayer {
                position: 0,
                layer_type: "flex".to_string(),
            },
            ReadIssue::DuplicateGroup {
                layer: 0,
                id: ItemId::new(52),
            },
            ReadIssue::GroupCycle { layer: 0, group: 1 },
            ReadIssue::DuplicateId {
                id: ItemId::new(105),
                holder: IdHolder::Connection,
            },
            ReadIssue::DanglingLink {
                from: at(0, 0, 1),
                target: ItemId::new(999),
            },
            ReadIssue::UnreciprocatedLink {
                from: at(0, 1, 1),
                to: at(0, 0, 0),
            },
            ReadIssue::UnreciprocatedLink {
                from: at(0, 3, 1),
                to: at(0, 3, 1),
            },
            ReadIssue::DanglingAttachment {
                layer: 1,
                ruler: 0,
                end: RulerEnd::Center,
                target: ItemId::new(77),
            },
        ]
    );
    assert_eq!(link(&map, at(0, 0, 0)), Some(at(0, 1, 0)));
    assert_eq!(link(&map, at(0, 1, 0)), Some(at(0, 0, 0)));
    for unresolved in [
        at(0, 0, 1),
        at(0, 1, 1),
        at(0, 2, 0),
        at(0, 2, 1),
        at(0, 3, 1),
    ] {
        assert_eq!(link(&map, unresolved), None, "{unresolved:?}");
    }
    let track = bricks(&map, 0);
    let parents: Vec<_> = track
        .groups
        .iter()
        .map(|group| (group.id.value(), group.parent))
        .collect();
    assert_eq!(parents, [(50, Some(1)), (51, None), (52, None), (53, None)]);
    assert_eq!(track.bricks[3].group, Some(3));
    let RulerShape::Circular { attachment, .. } = &rulers(&map, 1).rulers[0].shape else {
        panic!("circular ruler");
    };
    assert_eq!(*attachment, None);
}
