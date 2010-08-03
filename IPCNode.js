var sys=require("sys");
var EventEmitter=require("events").EventEmitter;
var IDProvider=require("./IDProvider").IDProvider;

var isDebug=false;
var defaultPrepareCount=0;//isDebug?-1:0;

//Helper functions
function getGlobal() {
	return (function(){return this;})();
}

function isNumeric(val) {
	return (typeof(val)==="number" || val==parseInt(val,10));
}

function IPCNode() {
	EventEmitter.call(this);
	this._pauseBuffer=[];
	this._buffer="";
	this._idp=new IDProvider();
	this._localObjects={};
	this._remoteObjects={};
	this._id=IPCNode._idp.alloc();
	this._waitingReleases=[];
	this._holdingReleases=0;
}

IPCNode._idp=new IDProvider();

function Base(){}
Base.prototype=EventEmitter.prototype;
IPCNode.prototype=new Base();
IPCNode.prototype.prepareCount=defaultPrepareCount;
/*************************\
* Readable stream methods *
\*************************/
IPCNode.prototype._closed=false;
IPCNode.prototype._paused=false;
IPCNode.prototype._pauseBuffer=undefined; //Should be set in constructor
IPCNode.prototype.readable=true;
IPCNode.prototype.setEncoding=function(encoding) {}; //Ignore for now
IPCNode.prototype.pause=function() {
	this._paused=true;
};
IPCNode.prototype.resume=function() {
	this._paused=false;
	while (!this._paused && this._pauseBuffer.length>0) {
		this.emit("data",this._pauseBuffer.shift());
	}
};
IPCNode.prototype.destroy=function() {
	this.end();
};
/**************************\
* Writeable stream methods *
\**************************/
IPCNode.prototype._buffer=undefined; //Should be set in constructor
IPCNode.prototype.writeable=true;
IPCNode.prototype.write=function(string,encoding) {
	if (string===undefined) {
		return true;
	}
	if (this._closed) {
		throw new Error("IPCNode was closed, unable to write: "+string);
	}
	this._buffer+=string;
	var split,line;
	while ((split=this._buffer.indexOf("\n"))!==-1) {
		line=this._buffer.substr(0,split);
		this._buffer=this._buffer.substr(split+1);
		try {
			this._onData(line);
		}
		catch(e) {
			this._emitError(e);
		}
	}
	return true;
};
IPCNode.prototype.end=function(string,encoding) {
	if (this._closed) {
		return;
	}
	this.write.apply(this,Array.prototype.slice.call(arguments,0));
	this._closed=true;
	this.writeable=false;
	this.readable=false;
	this.emit("end");
	this.emit("close");
};
//See Readable Stream for destroy
/***********\
* Constants *
\***********/
IPCNode.commands={
	register: isDebug?"register":0,
	call: isDebug?"call":1,
	release: isDebug?"release":2,
	infoRequest: isDebug?"infoRequest":3,
	infoResponse: isDebug?"infoResponse":4
};
IPCNode.objectSource={
	local: isDebug?"local":0,
	marshalled: isDebug?"marshalled":1,
	global: isDebug?"global":2
};
/****************\
* Outgoing stuff *
\****************/
IPCNode.prototype._emitError=function(err) {
	this._closed=true;
	this.emit("error",err);
};
IPCNode.prototype._emitObject=function(obj) {
	this._emitData(JSON.stringify(obj)+"\n");
};
IPCNode.prototype._emitData=function(data) {
	if (this._closed) {
		throw new Error("_emitData: IPCNode is closed: "+data.toString());
	}
	if (!this._paused) {
		this.emit("data",data);
	} else {
		if (typeof(this._pauseBuffer)!=="object") {
			this._pauseBuffer=[data];
		} else {
			this._pauseBuffer.push(data);
		}
	}
};
IPCNode.prototype._emitReleases=function() {
	var i,cur,command;
	if (this._holdingReleases>0) {
		for (i=0; i<arguments.length; i++) {
			cur=arguments[i];
			if (!isNumeric(cur)) {
				continue;
			}
			this._waitingReleases.push(cur);
		}
	} else {
		command=[IPCNode.commands.release];
		for (i=0; i<arguments.length; i++) {
			cur=arguments[i];
			if (!isNumeric(cur)) {
				continue;
			}
			command.push(cur);
		}
		if (command.length>1) {
			this._emitObject(command);
		}
		this._checkClean();
	}
};
IPCNode.prototype._holdReleases=function() {
	this._holdingReleases++;
};
IPCNode.prototype._unholdReleases=function() {
	if (this._holdingReleases === 0) {
		throw new Error("_unholdReleases: not held");
	}
	if (--this._holdingReleases === 0) {
		if (this._waitingReleases.length>0) {
			var command=[IPCNode.commands.release].concat(this._waitingReleases);
			this._waitingReleases=[];
			this._emitObject(command);
		}
		this._checkClean();
	}
};
IPCNode.prototype.register=function() {
	return this._emitMarshalledCommand(IPCNode.commands.register,Array.prototype.slice.call(arguments));
};
IPCNode.prototype._call=function() {
	return this._emitMarshalledCommand(IPCNode.commands.call,Array.prototype.slice.call(arguments));
};
IPCNode.prototype._onInfoRequest=function() {
	var ids=Array.prototype.slice.call(arguments),
		self=this,
		objectTable={},
		marshalled=[],
		requested=[],
		toPrepare=IPCNode.prototype.prepareCount,
		i,id,object,currentInfo;
	function marshalLocalObjectCallback(localObject) {
		var id=self._marshalLocalObject(localObject,objectTable);
		marshalled.push(id);
		return id;
	}
	//Marshal each one of them to the object table, but don't store the result
	ids.forEach(function(id) {
		if (!isNumeric(id)) {
			return;
		}
		var localObject=self._localObjects[id];
		if (typeof(localObject)!=="object") {
			throw new Error("Local object "+id+" not found");
		}
		//Marshal it, but don't store. Will make sure it ends up in the object Table
		requested.push({id:marshalLocalObjectCallback(localObject.object),object:localObject.object});
	});
	//For all requested IDs, make sure the properties are set
	requested.forEach(function(x) {
		var id=x.id,
			object=x.object,
			currentInfo;
		if (!isNumeric(id)) {
			return;
		}
		currentInfo=objectTable[id];
		if (typeof(currentInfo)==="undefined" || typeof(currentInfo)==="object") {
			return; //Either non-existing, or already done
		}
		objectTable[id]=[currentInfo,self._marshalProperties(object,marshalLocalObjectCallback)];
	});
	//Attempt to prepare some extra objects
	for (i=0; i<marshalled.length && toPrepare!==0; i++) {
		id=marshalled[i].id;
		object=marshalled[i].object;
		if (!isNumeric(id)) {
			continue;
		}
		currentInfo=objectTable[id];
		if (typeof(currentInfo)==="undefined" || typeof(currentInfo)==="object") {
			continue; //Either non-existing, or already done
		}
		if (toPrepare>0) {
			toPrepare--;
		}
		objectTable[id]=[currentInfo,self._marshalProperties(object,marshalLocalObjectCallback)];
	}
	//Send
	return this._emitObject([IPCNode.commands.infoResponse,objectTable]);
};
/*************\
* Marshalling *
\*************/
IPCNode.prototype._emitMarshalledCommand=function(cmd,args) {
	var self=this,
		objectTable={},
		marshalled=[],
		marshalledArgs,
		toPrepare=IPCNode.prototype.prepareCount,
		i,id,object,currentInfo;
	function marshalLocalObjectCallback(localObject) {
		var id=self._marshalLocalObject(localObject,objectTable);
		marshalled.push({id:id,object:localObject});
		return id;
	}
	marshalledArgs=args.map(function(value) { return self._marshalValue(value,marshalLocalObjectCallback); });
	//Send some extra properties over the wire
	for (i=0; i<marshalled.length && toPrepare!==0; i++) {
		id=marshalled[i].id;
		object=marshalled[i].object;
		if (!isNumeric(id)) {
			continue;
		}
		currentInfo=objectTable[id];
		if (typeof(currentInfo)==="undefined" || typeof(currentInfo)==="object") {
			continue; //Either non-existing, or already done
		}
		if (toPrepare>0) {
			toPrepare--;
		}
		objectTable[id]=[currentInfo,self._marshalProperties(object,marshalLocalObjectCallback)];
	}
	this._emitObject([cmd,objectTable].concat(marshalledArgs));
};
IPCNode.prototype._marshalValue=function(value,marshalLocalObjectCallback) {
	var self=this;
	if (value===null || value===undefined || typeof(value)==="string" || typeof(value)==="number" || typeof(value)==="boolean") {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map(function(subvalue) { return self._marshalValue(subvalue,marshalLocalObjectCallback); });
	}
	if (value===getGlobal()) {
		return {t:IPCNode.objectSource.global};
	}
	if (typeof(value)==="object" || typeof(value)==="function") {
		if (value.__ipc_owner == this) {
			if (typeof(value.__ipc_object)!=="object") {
				throw new Error("Attempt to use disposed object");
			}
			return {t:IPCNode.objectSource.local,i:value.__ipc_object.id};
		}
		return {t:IPCNode.objectSource.marshalled,i:marshalLocalObjectCallback(value)};
	}
	throw new Error("Unable to marshal value: "+value);
};
IPCNode.prototype._marshalProperties=function(object,marshalLocalObjectCallback) {
	var ret={},
		key;
	for (key in object) {
		if (key.substr(0,6)!=="__ipc_") {
			ret[key]=this._marshalValue(object[key],marshalLocalObjectCallback);
		}
	}
	return ret;
};
IPCNode.prototype._marshalLocalObject=function(object,objectTable) {
	var localObject=object["__ipc_info_"+this._id],
		id,
		type;
	if (typeof(localObject)!=="object" || this._localObjects[localObject.id]!==localObject) {
		id=this._idp.alloc();
		localObject=object["__ipc_info_"+this._id]=this._localObjects[id]={id:id,refCount:1,object:object};
		type=typeof(object);
		objectTable[id]=type.substr(0,1);
		return id;
	} else {
		id=localObject.id;
		if (typeof(objectTable[id])==="undefined") {
			type=typeof(object);
			objectTable[id]=type.substr(0,1);
			localObject.refCount++;
		}
		return localObject.id;
	}
};
IPCNode.prototype._releaseLocals=function(ids) {
	var self=this;
	ids.forEach(function(id) {
		if (!isNumeric(id)) {
			return;
		}
		var localObject=self._localObjects[id];
		if (typeof(localObject)!=="object") {
			throw new Error("Unknown local ID "+id);
		}
		if (--localObject.refCount === 0) {
			delete self._localObjects[id];
			delete localObject.object["__ipc_id_"+self._id];
			self._idp.free(parseInt(id,10));
		}
	});
	if (ids.length>0) {
		this._checkClean();
	}
};
IPCNode.prototype._onRelease=function() {
	var ids=Array.prototype.slice.call(arguments);
	this._releaseLocals(ids);
};
/****************\
* Incoming stuff *
\****************/
IPCNode.prototype._onData=function(data) {
	if (this._closed) {
		throw new Error("IPCNode is closed");
	}
	try {
		return this._onObject(JSON.parse(data));
	}
	catch(e) {
		this._emitError(e);
	}
};
IPCNode.prototype._onObject=function(obj) {
	if (!Array.isArray(obj)) {
		throw new Error("Expected Array as object");
	}
	var cmd=obj[0];
	switch (cmd) {
		case IPCNode.commands.register: return this._onRegister.apply(this,obj.slice(1));
		case IPCNode.commands.call: return this._onCall.apply(this,obj.slice(1));
		case IPCNode.commands.release: return this._onRelease.apply(this,obj.slice(1));
		case IPCNode.commands.infoRequest: return this._onInfoRequest.apply(this,obj.slice(1));
		case IPCNode.commands.infoResponse: return this._onInfoResponse.apply(this,obj.slice(1));
		default: throw new Error("Unsupported command: "+cmd);
	}
};
IPCNode.prototype._onRegister=function(marshalledObjectTable) {
	var self=this;
	this._unmarshalArguments(Array.prototype.slice.call(arguments),function(args) {
		self.emit.apply(self,["register"].concat(args));
	});
};
IPCNode.prototype._onInfoResponse=function(marshalledObjectTable) {
	this._unmarshalArguments(Array.prototype.slice.call(arguments),function(args) {
		//Don't do anything :)
	});
};
IPCNode.prototype._onCall=function(marshalledObjectTable) {
	this._unmarshalArguments(Array.prototype.slice.call(arguments),function(args) {
		var f=args[0],
			t=args[1],
			a=args.slice(2);
		if (typeof(f)!=="function") {
			throw new Error("Can only call functions");
		}
		f.apply(t,a);
	});
};
/***************\
* Unmarshalling *
\***************/
IPCNode.prototype._unmarshalArguments=function(args,resultCallback) {
	var marshalledObjectTable=args.shift(),
		objectTableCallbacks=[],
		objectTable,
		localObjects={},
		self=this,
		unused;
	
	function requestObjectTable(resultCallback) {
		if (objectTable===undefined) {
			objectTableCallbacks.push(resultCallback);
		} else {
			resultCallback(objectTable);
		}
	}
	function localObjectUnmarshaller(id,resultCallback) {
		if (!isNumeric(id)) {
			throw new Error("ID is not numeric");
		}
		var localObject=localObjects[id];
		if (typeof(localObject)!=="object") {
			localObjects[id]=localObject=self._localObjects[id];
			if (typeof(localObject)!=="object") {
				throw new Error("Unknown local id "+id);
			}
			localObject.refCount++;
		}
		resultCallback(localObject.object);
	}
	function remoteObjectUnmarshaller(id,resultCallback) {
		requestObjectTable(function(objectTable) {
			self._unmarshalFromObjectTable(objectTable,id,resultCallback);
		});
	}
	this._holdReleases();
	this._unmarshalArray(args,localObjectUnmarshaller,remoteObjectUnmarshaller,function(unmarshalledArgs) {
		resultCallback(unmarshalledArgs);
		//Free up object table
		requestObjectTable(function(objectTable) {
			self._disposeObjectTable(objectTable);
		});
	});
	unused=this._unmarshalObjectTable(marshalledObjectTable,function(unmarshalledObjectTable) {
		objectTable=unmarshalledObjectTable;
		objectTableCallbacks.forEach(function(c) {
			c(unmarshalledObjectTable);
		});
		self._releaseLocals(Object.keys(localObjects).filter(isNumeric));
	});
	this._emitReleases.apply(this,unused);
	this._unholdReleases();
};
IPCNode.prototype._unmarshalValue=function(value,localObjectUnmarshaller,remoteObjectUnmarshaller,resultCallback) {
	if (value===null || value===undefined || typeof(value)==="string" || typeof(value)==="number" || typeof(value)==="boolean") {
		return resultCallback(value);
	}
	if (Array.isArray(value)) {
		return this._unmarshalArray(value,localObjectUnmarshaller,remoteObjectUnmarshaller,resultCallback);
	}
	if (typeof(value)==="object") {
		return this._unmarshalObject(value,localObjectUnmarshaller,remoteObjectUnmarshaller,resultCallback);
	}
	throw new Error("Unable to unmarshal: "+value);
};
IPCNode.prototype._unmarshalArray=function(arr,localObjectUnmarshaller,remoteObjectUnmarshaller,resultCallback) {
	var ret=[],
		self=this,
		todo=1;
	function checkDone() {
		if (todo===0) {
			resultCallback(ret);
		}
	}
	arr.forEach(function(value,key) {
		todo++;
		self._unmarshalValue(value,localObjectUnmarshaller,remoteObjectUnmarshaller,function(unmarshalledValue) {
			ret[key]=unmarshalledValue;
			todo--;
			checkDone();
		});
	});
	todo--;
	checkDone();
};
IPCNode.prototype._unmarshalObject=function(obj,localObjectUnmarshaller,remoteObjectUnmarshaller,resultCallback) {
	switch (obj.t) {
		case IPCNode.objectSource.global: return resultCallback(getGlobal());
		case IPCNode.objectSource.local: return localObjectUnmarshaller(obj.i,resultCallback);
		case IPCNode.objectSource.marshalled: return remoteObjectUnmarshaller(obj.i,resultCallback);
		default:
			throw new Error("Unknown object type: "+obj.t);
	}
};
function createStubFunction() {
	return function() {
		var f=arguments.callee,
			owner=f.__ipc_owner,
			args=[f,this].concat(Array.prototype.slice.call(arguments));
		if (typeof(owner)!=="object") {
			throw new Error("IPC object has been disposed");
		}
		owner._call.apply(owner,args);
	};
}
IPCNode.prototype._unmarshalFromObjectTable=function(objectTable,id,resultCallback) {
	if (!isNumeric(id)) {
		throw new Error("Unable to unmarshal ID "+id+", not numeric");
	}
	var remoteObject=objectTable[id];
	if (typeof(remoteObject)!=="object") {
		throw new Error("Unable to unmarshal ID "+id+", not in table");
	}
	if (remoteObject.isReady) {
		return resultCallback(remoteObject.stub);
	}
	remoteObject.readyCallbacks.push(function() {
		resultCallback(remoteObject.stub);
	});
};
IPCNode.prototype._unmarshalObjectTable=function(objectTable,resultCallback) {
	var id,
		type,
		infoCache={},
		remoteObject,
		notUsed=[],
		unmarshalledTable={},
		stub,
		requestProperties=[IPCNode.commands.infoRequest],
		todo=1;
	//Step one: Ensure that a _remoteObject exists for all objects, and increase the reference count.
	for (id in objectTable) {
		if (isNumeric(id)) {
			type=objectTable[id];
			if (typeof(type)==="object") {
				infoCache[id]=type[1];
				type=type[0];
			}
			remoteObject=this._remoteObjects[id];
			if (typeof(remoteObject)!=="object") {
				switch (type) {
					case "f": stub=createStubFunction(); break;
					case "o": stub={}; break;
					default: throw new Error("Unable to unmarshal object: unknown type "+type);
				}
				Object.defineProperty(stub,"__ipc_owner",{value:this,enumerable:false,configurable:true});
				remoteObject=this._remoteObjects[id]=unmarshalledTable[id]={
					id: id,
					refCount: 1,
					externalRefCount: 0,
					usedBy: {},
					uses: {},
					usedLocals: {},
					hasProperties: false,
					hasRequested: false,
					type: type,
					stub: stub,
					isReady: false,
					readyCallbacks: []
				};
				Object.defineProperty(stub,"__ipc_object",{value:remoteObject,enumerable:false,configurable:true});
			} else {
				remoteObject.refCount++;
				unmarshalledTable[id]=remoteObject;
				notUsed.push(id);
			}
		}
	}
	//Step 2: Apply the infoCache to all objects not yet having properties (and attempt to make them ready)
	for (id in infoCache) {
		if (isNumeric(id)) {
			remoteObject=unmarshalledTable[id];
			if (typeof(remoteObject)==="object" && !remoteObject.hasProperties) {
				this._applyProperties(remoteObject,infoCache[id],unmarshalledTable);
			}
		}
	}
	//Step 3: Request information for any object that does not have it yet.
	for (id in unmarshalledTable) {
		if (isNumeric(id)) {
			remoteObject=unmarshalledTable[id];
			if (typeof(remoteObject)==="object" && !remoteObject.hasProperties && !remoteObject.hasRequested) {
				remoteObject.hasRequested=true;
				requestProperties.push(remoteObject.id);
			}
		}
	}
	if (requestProperties.length>1) {
		this._emitObject(requestProperties);
	}
	//Step 4: Check all objects if they're ready, and if not, wait for them
	function checkDone() {
		if (todo===0) {
			resultCallback(unmarshalledTable);
		}
	}
	function readyCallback() {
		todo--;
		checkDone();
	}
	for (id in unmarshalledTable) {
		if (isNumeric(id)) {
			remoteObject=unmarshalledTable[id];
			if (typeof(remoteObject)==="object" && !this._checkReady(remoteObject)) {
				todo++;
				remoteObject.readyCallbacks.push(readyCallback);
			}
		}
	}
	todo--;
	checkDone();
	//Step 3: Return notUsed table, so command can do a release on those.
	return notUsed;
};
IPCNode.prototype._disposeObjectTable=function(objectTable) {
	var currentObject,id;
	for (id in objectTable) {
		if (isNumeric(id)) {
			currentObject=objectTable[id];
			if (typeof(currentObject)==="object") {
				this._releaseStub(currentObject);
			}
		}
	}
};
IPCNode.prototype._addrefStub=function(remoteObject) {
	remoteObject.refCount++;
};
IPCNode.prototype._releaseStub=function(remoteObject) {
	if (remoteObject.refCount<1) {
		throw new Error("Object is already fully released");
	}
	remoteObject.refCount--;
	this._checkDispose(remoteObject);
};
IPCNode.prototype._applyProperties=function(remoteObject,properties,objectTable) {
	var key,stub,
		self=this;
	remoteObject.hasProperties=true;
	stub=remoteObject.stub;
	function localObjectUnmarshaller(id,resultCallback) {
		if (!isNumeric(id)) {
			throw new Error("Unable to unmarshal local object: id is not numeric");
		}
		var localObject=remoteObject.usedLocals[id];
		if (typeof(localObject)!=="object") {
			localObject=self._localObjects[id];
			if (typeof(localObject)!=="object") {
				throw new Error("Local object "+id+" not found");
			}
			remoteObject.usedLocals[id]=localObject;
			localObject.refCount++;
		}
		resultCallback(localObject.object);
	}
	function remoteObjectUnmarshaller(id,resultCallback) {
		if (!isNumeric(id)) {
			throw new Error("ID is not numeric!");
		}
		var referencedObject=objectTable[id];
		if (typeof(referencedObject)!=="object") {
			throw new Error("Remote object with "+id+" not in object table");
		}
		remoteObject.uses[id]=referencedObject;
		referencedObject.usedBy[remoteObject.id]=remoteObject;
		resultCallback(referencedObject.stub);
	}
	function createResultCallback(key) {
		return function(value) {
			stub[key]=value;
		};
	}
	for (key in properties) {
		if (properties.hasOwnProperty(key)) {
			this._unmarshalValue(properties[key],localObjectUnmarshaller,remoteObjectUnmarshaller,createResultCallback(key));
		}
	}
};
IPCNode.prototype._checkDispose=function(remoteObject) {
	//Check entire tree through usedBy for non-zero reference counts
	var q=[remoteObject],
		seen={}, //Objects already seen and checked
		toDispose=[], //Objects that should be disposed
		toCheck=[], //Objects that were used by disposed objects that should be checked for disposing
		currentObject,
		useId,
		referencedObject,
		self=this,
		releases=[];
	seen[remoteObject.id]=true;
	while (q.length>0) {
		currentObject=q.shift();
		if (currentObject.refCount>0) {
			return false;
		}
		toDispose.push(currentObject);
		//Note: No need to check for hasProperties or hasRequested, if there is anything left still checking that, the refcount should be non-zero
		//Add used-by to queue
		for (useId in currentObject.usedBy) {
			if (isNumeric(useId) && !seen[useId]) {
				referencedObject=currentObject.usedBy[useId];
				if (typeof(referencedObject)==="object") {
					seen[useId]=true;
					q.push(referencedObject);
				}
			}
		}
	}
	//If at this point, we should dispose of everone in the toDispose list.
	//Also, seen contains all IDs in this list.
	this._holdReleases();
	toDispose.forEach(function(disposeObject) {
		var stub=disposeObject.stub,
			uses=disposeObject.uses,
			id=disposeObject.id,
			useId,
			referencedObject,
			locals;
		disposeObject.uses={};
		//Since we don't keep a list, we can't remove properties.
		//Could be a good thing: simple objects containing just simple stuff will still work fine even when disposed, only when calling any functions on it will it fail.
		//Remove uses
		for (useId in uses) {
			if (isNumeric(useId)) {
				referencedObject=uses[useId];
				if (typeof(referencedObject)==="object") {
					delete referencedObject.usedBy[id];
					if (!seen[useId]) {
						seen[useId]=true;
						toCheck.push(referencedObject);
					}
				}
			}
		}
		//Unreference locals
		locals=Object.keys(disposeObject.usedLocals).filter(isNumeric);
		disposeObject.usedLocals={};
		self._releaseLocals(locals);
		//Remove object
		delete stub.__ipc_object;
		//Remove from table
		delete self._remoteObjects[id];
		//Add to release table
		releases.push(id);
	});
	toCheck.forEach(function(referencedObject) {
		self._checkDispose(referencedObject);
	});
	this._emitReleases.apply(this,releases);
	this._unholdReleases();
};
IPCNode.prototype._checkReady=function(remoteObject) {
	var q=[remoteObject], //Queue for BFS
		seen={}, //Objects already seen and checked
		toSignal=[], //Objects that should be set to ready
		usedBy={},
		currentObject,
		useId,
		i,
		callbacks=[];
	seen[remoteObject.id]=true;
	while (q.length) {
		currentObject=q.shift();
		if (!currentObject.isReady) {
			if (!currentObject.hasProperties) {
				return false;
			}
			toSignal.push(currentObject);
			for (useId in currentObject.uses) {
				if (isNumeric(useId) && !seen[useId]) {
					seen[useId]=true;
					q.push(currentObject.uses[useId]);
				}
			}
		}
	}
	//Set all objects in the path to ready
	for (i=0; i<toSignal.length; i++) {
		currentObject=toSignal[i];
		//Set it to ready
		currentObject.isReady=true;
		//Keep a list of all objects that are using objects we're now signalling
		for (useId in currentObject.usedBy) {
			if (isNumeric(useId)) {
				usedBy[useId]=currentObject.usedBy[useId];
			}
		}
		//Keep a list of all callbacks we should signal once ready.
		callbacks=callbacks.concat(currentObject.readyCallbacks);
		currentObject.readyCallbacks=[];
	}
	//Call all callbacks
	for (i=0; i<callbacks.length; i++) {
		callbacks[i]();
	}
	//Check all objects that are using any of the objects we're using.
	for (useId in usedBy) {
		if (isNumeric(useId)) {
			currentObject=usedBy[useId];
			if (typeof(currentObject)==="object") {
				this._checkReady(currentObject);
			}
		}
	}
	return true;
};
/*******************\
* General functions *
\*******************/
IPCNode.prototype._checkClean=function() {
	if (
		Object.keys(this._localObjects).filter(isNumeric).length === 0 &&
		Object.keys(this._remoteObjects).filter(isNumeric).length === 0 &&
		this._holdingReleases===0 &&
		this._waitingReleases.length===0
	) {
		this.emit("clean");
	}
};
/****\
*    *
\****/

IPCNode.reference=function(obj) {
	if (typeof(obj)!=="object" && typeof(obj)!=="function") {
		return obj;
	}
	var owner=obj.__ipc_owner,
		remoteObject;
	if (typeof(owner)!=="object") {
		return obj;
	}
	remoteObject=obj.__ipc_object;
	if (typeof(remoteObject)!=="object") {
		throw new Error("Remote object was already disposed");
	}
	remoteObject.refCount++;
	remoteObject.externalRefCount++;
	return obj;
};
IPCNode.dispose=function(obj) {
	if (typeof(obj)!=="object" && typeof(obj)!=="function") {
		return;
	}
	var owner=obj.__ipc_owner,
		remoteObject;
	if (typeof(owner)!=="object") {
		return;
	}
	remoteObject=obj.__ipc_object;
	if (typeof(remoteObject)!=="object") {
		throw new Error("Remote object was already disposed");
	}
	if (remoteObject.externalRefCount<1) {
		throw new Error("Remote object was not referenced any more");
	}
	remoteObject.refCount--;
	remoteObject.externalRefCount--;
	owner._checkDispose(remoteObject);
};
exports.IPCNode=IPCNode;

IPCNode.async=function(func) {
	return function() {
		var args=Array.prototype.slice.call(arguments),
			last,
			caught;
		if (args.length>0) {
			last=args[args.length-1];
			if (typeof(last)==="function") {
				args[args.length-1]=(function(f) {
					var copy=IPCNode.reference(f);
					return function() {
						try {
							copy.apply(this,Array.prototype.slice.call(arguments));
						}
						catch(e) {
							//Do nothing
						}
						IPCNode.dispose(copy);
					};
				})(last);
			}
		}
		try {
			func.apply(this,args);
		}
		catch(e) {
			caught=e;
		}
		if (caught!==undefined) {
			throw caught;
		}
	};
};
IPCNode.sync=function(func) {
	return function() {
		var args=Array.prototype.slice.call(arguments),
			resultCallback,
			returnValue,
			last,
			caught;
		if (args.length>0) {
			last=args[args.length-1];
			if (typeof(last)==="function") {
				resultCallback=args.pop();
			}
		}
		try {
			returnValue=func.apply(this,args);
		}
		catch(e) {
			caught=e;
		}
		if (typeof(resultCallback)==="function") {
			resultCallback(returnValue);
		}
		if (caught!==undefined) {
			throw caught;
		}
	};
};