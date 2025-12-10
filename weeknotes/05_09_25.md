---
layout: default
title: 05/09/25
---

This was my last week working on topogmesh and I wanted to conclude my weeknotes with an overview of the project itself and some things someone who is interested could do with the code. topogmesh now supports the use of OSM data for any Raster on earth to add colours and details to terrain models which fixes my problem from weeks ago about accurate data for rivers and other natural sources of water. This can also be applied to any of the other features within the OSM database (such as forests) which has allowed for this print of the Crater Lake within [Mount Rinjani](https://en.wikipedia.org/wiki/Mount_Rinjani). 

![Mount Rinjani print](images/05_09_25/mount_rinjani.png)

Thanks again to Michael for printing this for me as its size and use of different colours caused the print to take over 10 hours and had to be printed twice due to a printing error. Another print Michael was able to do using topogmesh, was this detailed model of the area surrounding the Liverpool Central Library. This is a good showcase of how detailed the [government lidar data](https://environment.data.gov.uk/survey) is and what topogmesh can do with it when combined with OSM data.

![Liverpool Central Library](images/05_09_25/liverpool_print.png)

This print reminded me of a display at the [London Centre](https://thelondoncentre.org/exhibitions), which shows a 16.5 metre long 1:2000 scale 3D model of London. However, unlike the exhibition (which is manually updated by developers and architects), topogmesh is entirely procedural and allows you to create models of anywhere in England using entirely open-source government LIDAR data. I recently added a tool to topogmesh to make this process even easier, where you just need to specify the area you want and it will automatically download the most recent data for that region.

So what could people do with the project? Here's a non-exhaustive list of some of my ideas and ideas I've heard from others. All of these aim to make use of how powerful having a 3D physical object is for visualising data and communicating abstract ideas:
- Having a 3D map for hiking trails on less commonly traversed mountain ranges
- Creating visual aids to show the recession of glaciers (creating different models for what they looked like at different points in recent history)
- A science communication tool for other effects humans have on the environment (showing the extent of deforestation and what effects rising sea levels will have on major cities)
- Creating city models for urban planners showing the relative scale of different parts of a city
- Showing what the terrain is like beneath buildings to help Architects and Civil Engineers
- Demonstrating the dangers of flooding on specific regions based on the shape of terrain beneath it
If you want to try out the code, it is all open source and available here on [github](https://github.com/quantifyearth/topogmesh).

Finally I want to say a big thank you to Michael for supervising me on this project and helping me along the way with some very insightful ideas. Another thank you I want to give, is to Anil, for running this UROP and giving me this opportunity. I've really enjoyed working on topogmesh and I hope some people check it out!