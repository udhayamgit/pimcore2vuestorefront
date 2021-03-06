const _ = require('lodash');
const fs = require('fs')
const path = require('path')
const shell = require('shelljs')
const attribute = require('../lib/attribute')

module.exports = class {
    constructor(config, api, db) {
        this.config = config
        this.db = db
        this.api = api
        this.single = this.single.bind(this)
    }

    /**
     * This is an EXAMPLE of custom Product / entity mapper; you can write your own to map the Pimcore entities to vue-storefront data format (see: templates/product.json for reference)
     * @returns Promise
     */
    single(pimcoreObjectData, convertedObject, childObjects, level = 1, parent_id = null) {
        return new Promise((resolve, reject) => {
            console.debug('Helo from custom product converter for', convertedObject.id)
            convertedObject.url_key = pimcoreObjectData.key // pimcoreObjectData.path?
            convertedObject.type_id = (childObjects.length > 0) ? 'configurable' : 'simple'

            let elements = pimcoreObjectData.elements
            let features = elements.find((elem) => elem.name === 'features')
            let categories = elements.find((elem) => elem.name === 'categories')
            let images = elements.find((elem) => elem.name === 'images')
            let materialComposition = elements.find((elem) => elem.name === 'materialComposition')
            let color = elements.find((elem) => elem.name === 'color')
            let gender = elements.find((elem) => elem.name === 'gender')
            let size = elements.find((elem) => elem.name === 'size')

            let localizedFields = elements.find((itm)=> { return itm.name === 'localizedfields'})
            
            let subPromises = []            

            if(size && size.value)
                subPromises.push(attribute.mapToVS('size', 'select', size.value).then((mappedValue) => {
                    convertedObject.size = mappedValue                    
                }))
            
            if(color && color.value)
                subPromises.push(attribute.mapToVS('color', 'select', Array.isArray(color.value) ? color.value.join(', ') : color.value).then((mappedValue) => {
                    convertedObject.color = mappedValue                    
                }))

            let imagePromises = []
            if(images && this.config.pimcore.downloadImages) {
                
                images.value.map((imgDescr) => {
                    let imgId = imgDescr.value[0].value
                    imagePromises.push(new Promise((imgResolve, imgReject) => {
                        shell.cd(path.join(__dirname, '../'))
                        let downloaderResult = shell.exec(`node index.js asset --id=${imgId}`, { silent: true })
                        if (downloaderResult) {
                            try {
                                let jsonResult = JSON.parse(_.trim(downloaderResult.stdout))
                                    if(jsonResult && jsonResult.relativePath) {
                                        convertedObject.image = jsonResult.relativePath
                                        console.debug('Image set to ', convertedObject.image)
                                    }
                                } catch (err) {
                                    console.log('ASSET OUTPUT', downloaderResult.stdout)
                                    console.error(err)
                                }
                        }
                        imgResolve()
                    }))
                })
                console.log('Downloading binary assets for ', convertedObject.id)
            }

            Promise.all(imagePromises).then((result) => {
                
                if(features && features.value) {
                    features.value.map((featDescr) => {
                        subPromises.push((this.api.get(`object/id/${featDescr.id}`).end((resp) => {
                        //  console.log('Feature', resp.body.data.elements.find((el) => { return el.name === 'localizedfields'}))
                        })))
                    })
                }
                convertedObject.category = []
                convertedObject.category_ids = []
                if(categories && categories.value) {
                    categories.value.map((catDescr) => {
                        subPromises.push(new Promise((catResolve, catReject) => {
                            this.api.get(`object/id/${catDescr.id}`).end((resp) => {
                                if(resp.body && resp.body.data) {
                                    let catLocalizedFields = resp.body.data.elements.find((el) => { return el.name === 'localizedfields'})
                                    let catObject = { category_id: catDescr.id }
                                    if(catLocalizedFields) {
                                        attribute.mapElements(catObject, catLocalizedFields.value, this.config.pimcore.locale)
                                        console.debug(' - mapped product category ', catObject)
                                    }
                                    catResolve(catObject)
                                    convertedObject.category.push(catObject)
                                    convertedObject.category_ids.push(catObject.category_id)
                                }
                            })
                        }))
                    })
                }

                convertedObject.configurable_children = [] // clear the options
                if (convertedObject.type_id === 'configurable'){
                    // here we're flattening the child array out, because it's specific to pimcore that children can have children here :)

                    let childObjectsFlattened = _.flatten(childObjects)

                    let color_options = new Set()
                    let size_options = new Set()
                    for(let childObject of childObjectsFlattened) {
                        let confChild = {
                            name: childObject.dst.name,
                            sku: childObject.dst.sku,
                            price: childObject.dst.price
                        }

                        childObject.dst.visibility = 1 // Magento's constant which means: skip in search and category results - we're hiding the variants from being visible within the categories
                        if(_.trim(childObject.dst.color) != '')
                            color_options.add(childObject.dst.color)

                        if(_.trim(childObject.dst.size) != '')
                            size_options.add(childObject.dst.size)

                        confChild.custom_attributes = [ // other custom attributes can be stored here as well
                            {
                                "value": childObject.dst.url_key,
                                "attribute_code": "url_key"
                            },
    /*                        {
                                "value": childObject.dst.small_image,
                                "attribute_code": "small_image"
                            },*/
                            {
                                "value": childObject.dst.image,
                                "attribute_code": "image"
                            },
                            {
                                "value": `${childObject.dst.size}`, // these attributes are used for configuration, todo: map to attribute dictionary to be used in Magento
                                "attribute_code": "size"
                            },
                            {
                                "value": `${childObject.dst.color}`, // TODO: map to enumerable attribute to be used in Magento - because are dictionary attrs in Magento
                                "attribute_code": "color"
                            },
                            
    /*                        {
                                "value": childObject.dst.thumbnail,
                                "attribute_code": "thumbnail"
                            }*/
                        ]
                        
                        
                        convertedObject.configurable_children.push(confChild)
                    }
                    console.debug(' - Configurable children for: ', convertedObject.id,  convertedObject.configurable_children.length, convertedObject.configurable_children)
                    convertedObject.color_options = Array.from(color_options) // this is vue storefront feature of setting up the combined options altogether in the parent for allowing filters to work on configurable products
                    convertedObject.size_options = Array.from(size_options)


                    const attrs = attribute.getMap()
                    const configurableAttrs = ['size', 'color']
                    convertedObject.configurable_options = []

                    configurableAttrs.map((attrCode) => {
                        let attr = attrs[attrCode]
                        let confOptions = {
                            "attribute_id": attr.id,
                            "values": [
                            ],
                            "product_id": convertedObject.id,
                            "label": attr.default_frontend_label
                        }
                        convertedObject[`${attrCode}_options`].map((op) => {
                            confOptions.values.push({
                                value_index: op
                            })
                        })
                        convertedObject.configurable_options.push(confOptions)
                    })
                } else {
                    convertedObject.configurable_options = []
                    convertedObject.configurable_children = []
                }
                
                Promise.all(subPromises).then(results => {
                    resolve({ src: pimcoreObjectData, dst: convertedObject })
                }).catch((reason) => { console.error(reason) })
            }).catch((reason) => { console.error(reason) })
        })
    }
}